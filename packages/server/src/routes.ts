import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { CoordinationList, ExportFormat, CrosspointRequest } from '@rfutils/shared';
import { EXPORT_FORMATS, classifyUpload } from '@rfutils/shared';
import { readUpload, writeFormat, detectFormat, type FieldMapping } from '@rfutils/shared/formats';
import { convertLicence, generateShow } from '@rfutils/shared/pmse';
import type { MonitorService } from './monitor/index.js';
import { coordinate, coordinateRadios, analyze } from '@rfutils/shared/coordination';
import { loadInventory, saveInventory } from './inventory/store.js';
import { loadCatalog } from './profiles/catalog.js';
import { loadPlugins, findPlugin, findPluginForModel } from './plugins/registry.js';
import { buildShureSetCommand, sendShureCommands, type ProgramTargetResult } from './programming/shureProgrammer.js';
import { sendLectrosonicsCommands } from './programming/lectrosonicsProgrammer.js';
import { LECTRO_PROGRAM_TEMPLATE } from './monitor/discovery/lectrosonicsProtocol.js';
import { renderProgramCommand } from '@rfutils/shared';
import type { TransportId } from '@rfutils/shared';
import type { CoordinationParams, CoordinationRadio, InventoryItem } from '@rfutils/shared';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function decodeText(buf: Buffer): string {
  let text = buf.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  return text;
}

/** Same routing rule the Convert tab applies before it picks an endpoint. */
function isPdfUpload(file: Express.Multer.File): boolean {
  return classifyUpload(file.buffer, file.originalname, file.mimetype) === 'pdf';
}

/**
 * Wrap an async route handler so a rejected promise is forwarded to Express's
 * error handling instead of becoming an unhandled rejection (Express 4 doesn't
 * do this itself).
 */
function wrap(
  handler: (req: Request, res: Response) => Promise<unknown>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/** Infer a control transport from a device-channel id's vendor prefix. */
function inferTransport(vendor: string): TransportId {
  if (vendor === 'lectrosonics') return 'lectrosonics-net';
  if (vendor === 'shure') return 'shure-command-strings';
  return 'none';
}

export function createApiRouter(monitor: MonitorService): Router {
  const router = Router();

  // --- File conversion (WSM / WWB / generic) -------------------------------

  /** Parse an uploaded text file into the model. For generic CSV, also return
   * the detected header + suggested column mapping so the UI can offer a
   * column-map dialog (the equivalent of wsm-wwb-bridge's mapping dialog). */
  router.post('/convert', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded (field name must be "file").' });
      return;
    }
    if (isPdfUpload(req.file)) {
      res.status(415).json({
        error: 'This is a PDF. Ofcom PMSE licence schedules go to POST /api/pmse/convert.',
      });
      return;
    }
    const text = decodeText(req.file.buffer);
    let mapping: FieldMapping | undefined;
    if (typeof req.body?.mapping === 'string' && req.body.mapping.trim()) {
      try {
        mapping = JSON.parse(req.body.mapping);
      } catch {
        res.status(400).json({ error: 'mapping must be valid JSON' });
        return;
      }
    }
    try {
      const read = readUpload(text, mapping);
      res.json({
        ...read,
        filename: req.file.originalname,
        channelCount: read.list.channels.length,
        exportFormats: EXPORT_FORMATS,
      });
    } catch (err) {
      res.status(422).json({ error: `Could not parse this file: ${(err as Error).message}` });
    }
  });

  /** Detect format only (cheap preview). */
  router.post('/detect', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }
    const format = isPdfUpload(req.file) ? 'pmse-pdf' : detectFormat(decodeText(req.file.buffer));
    res.json({ format });
  });

  /** Export a model to a target format. Body: { list, format }. */
  router.post('/export', (req: Request, res: Response) => {
    const list = req.body?.list as CoordinationList | undefined;
    const format = req.body?.format as ExportFormat | undefined;
    if (!list || !Array.isArray(list.channels) || !format) {
      res.status(400).json({ error: 'Body must be { list: {channels}, format }.' });
      return;
    }
    const info = EXPORT_FORMATS.find((f) => f.id === format);
    if (!info) {
      res.status(400).json({ error: `Unknown export format: ${format}` });
      return;
    }
    try {
      let content: string;
      if (format === 'wwb-shw') {
        content = generateShow(
          list.channels.map((c) => ({ frequencyMhz: c.frequencyMhz, suggestedName: c.name })),
          { showName: 'RFutils Export' }
        );
      } else {
        content = writeFormat(list, format);
      }
      res.setHeader('Content-Type', info.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="rfutils-export.${info.extension}"`);
      res.send(content);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- PMSE licence PDF -> WWB ---------------------------------------------

  router.post('/pmse/convert', upload.single('file'), wrap(async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No PDF uploaded (field name must be "file").' });
      return;
    }
    if (!isPdfUpload(req.file)) {
      res.status(400).json({ error: 'Please upload a PDF file.' });
      return;
    }
    try {
      const conversion = await convertLicence(new Uint8Array(req.file.buffer));
      if (conversion.assignmentCount === 0) {
        res.status(422).json({
          error:
            'No frequency assignments were found in this PDF. It may not be an Ofcom PMSE licence schedule.',
          warnings: conversion.warnings,
        });
        return;
      }
      res.json(conversion);
    } catch (err) {
      res.status(422).json({ error: `Could not parse this PDF: ${(err as Error).message}` });
    }
  }));

  // --- Frequency coordination ---------------------------------------------

  /**
   * Coordinate new frequencies.
   *
   * Body is either `{ radios, params }` — each radio carrying its own tuning
   * ranges, raster and required spacing from the equipment catalog — or the
   * older `{ count, params, names? }` for a homogeneous set with no equipment
   * data. `radios` wins when both are present.
   */
  router.post('/coordinate', (req: Request, res: Response) => {
    const params = req.body?.params as CoordinationParams | undefined;
    if (!params || !Array.isArray(params.ranges)) {
      res.status(400).json({ error: 'Body must include params: { ranges, ... }.' });
      return;
    }
    const radios = req.body?.radios as CoordinationRadio[] | undefined;
    if (Array.isArray(radios)) {
      if (radios.some((r) => !r || typeof r.name !== 'string')) {
        res.status(400).json({ error: 'Each radio must have a name.' });
        return;
      }
      try {
        res.json(coordinateRadios(radios, params));
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
      return;
    }
    const count = Number(req.body?.count);
    const names = req.body?.names as string[] | undefined;
    if (!Number.isFinite(count)) {
      res.status(400).json({ error: 'Body must be { count, params } or { radios, params }.' });
      return;
    }
    try {
      res.json(coordinate(count, params, names));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Equipment profiles + band presets (built-in merged with the user's file). */
  router.get('/profiles', (_req: Request, res: Response) => {
    res.json(loadCatalog());
  });

  /** Product plugins (built-in + user plugins from ~/.rfutils/plugins/). */
  router.get('/plugins', (_req: Request, res: Response) => {
    res.json({ plugins: loadPlugins() });
  });

  /** Analyze an existing set for conflicts. Body: { frequencies: number[], params }. */
  router.post('/analyze', (req: Request, res: Response) => {
    const frequencies = req.body?.frequencies as number[] | undefined;
    const params = req.body?.params as CoordinationParams | undefined;
    if (!Array.isArray(frequencies) || !params) {
      res.status(400).json({ error: 'Body must be { frequencies: number[], params }.' });
      return;
    }
    try {
      res.json(analyze(frequencies, params));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- System inventory (persisted equipment list) -------------------------

  router.get('/inventory', (_req: Request, res: Response) => {
    res.json(loadInventory());
  });

  /** Replace the whole inventory. Body: { items: InventoryItem[] }. */
  router.put('/inventory', (req: Request, res: Response) => {
    const items = req.body?.items as InventoryItem[] | undefined;
    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Body must be { items: InventoryItem[] }.' });
      return;
    }
    try {
      res.json(saveInventory(items));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Programming (push frequencies to devices) ---------------------------

  /**
   * Program frequencies into receivers. Body: { targets: [{channelId,
   * frequencyMhz}], dryRun }. Dry-run (the default) returns the exact command
   * strings without connecting. Only Shure command-strings channels are
   * supported for live programming; export a file for anything else.
   */
  router.post('/program', wrap(async (req: Request, res: Response) => {
    const targets = req.body?.targets as
      | Array<{ channelId: string; frequencyMhz: number; pluginId?: string }>
      | undefined;
    const dryRun = req.body?.dryRun !== false; // default to safe dry-run
    if (!Array.isArray(targets)) {
      res.status(400).json({ error: 'Body must be { targets: [{channelId, frequencyMhz}], dryRun }.' });
      return;
    }

    const results: ProgramTargetResult[] = [];
    // Group live sends by transport + address so one connection carries all of
    // a receiver's channels. Key is `${transport}\0${address}`.
    const groups = new Map<
      string,
      { transport: TransportId; address: string; cmds: Array<{ channelId: string; command: string }> }
    >();

    for (const t of targets) {
      const parts = String(t.channelId).split(':');
      if (parts.length !== 3) {
        results.push({
          channelId: t.channelId, address: '', command: '', sent: false, ok: false,
          error: 'channelId must be "vendor:address:channel".',
        });
        continue;
      }
      const [vendor, address, chan] = parts as [string, string, string];

      // Resolve the product plugin: explicit pluginId wins, else auto-match the
      // discovered device's model. The transport is the plugin's, else inferred
      // from the channel's vendor prefix.
      const deviceModel = monitor.snapshot().find((d) => d.address === address)?.model;
      const plugin = findPlugin(t.pluginId) ?? findPluginForModel(deviceModel);
      const transport: TransportId = plugin?.control?.transport ?? inferTransport(vendor);

      const template =
        plugin?.control?.transport === transport && plugin.control.programTemplate
          ? plugin.control.programTemplate
          : undefined;

      let command: string;
      if (transport === 'shure-command-strings') {
        command = template
          ? renderProgramCommand(template, chan, Number(t.frequencyMhz))
          : buildShureSetCommand(chan, Number(t.frequencyMhz));
      } else if (transport === 'lectrosonics-net') {
        command = renderProgramCommand(template ?? LECTRO_PROGRAM_TEMPLATE, chan, Number(t.frequencyMhz));
      } else {
        results.push({
          channelId: t.channelId, address, command: '', sent: false, ok: false,
          error: `This device's transport (${transport}) can't be live-programmed; export a file instead.`,
        });
        continue;
      }

      results.push({ channelId: t.channelId, address, command, sent: false, ok: dryRun });
      if (!dryRun) {
        const key = `${transport}\0${address}`;
        const group = groups.get(key) ?? { transport, address, cmds: [] };
        group.cmds.push({ channelId: t.channelId, command });
        groups.set(key, group);
      }
    }

    if (!dryRun) {
      for (const { transport, address, cmds } of groups.values()) {
        const send = transport === 'lectrosonics-net' ? sendLectrosonicsCommands : sendShureCommands;
        const r = await send(address, cmds.map((c) => c.command));
        for (const c of cmds) {
          const entry = results.find((x) => x.channelId === c.channelId);
          if (entry) {
            entry.sent = true;
            entry.ok = r.ok;
            entry.reply = r.reply;
            if (r.error) entry.error = r.error;
          }
        }
      }
    }

    res.json({ dryRun, results });
  }));

  // --- Live monitoring (device snapshot + Companion routing) ---------------

  router.get('/devices', (_req: Request, res: Response) => {
    res.json({ devices: monitor.snapshot() });
  });

  /** Which audio-cue mode is active: 'capture' (DVS/Dante interface via
   * Companion) or 'direct' (decode AES67 multicast). */
  router.get('/audio/mode', (_req: Request, res: Response) => {
    res.json({ mode: monitor.audioMode(), cueBusConfigured: monitor.cueBusConfigured() });
  });

  router.get('/companion/status', wrap(async (_req: Request, res: Response) => {
    res.json(await monitor.companionStatus());
  }));

  router.post('/companion/make-crosspoint', wrap(async (req: Request, res: Response) => {
    try {
      await monitor.makeCrosspoint(req.body as CrosspointRequest);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  router.post('/companion/clear-crosspoint', wrap(async (req: Request, res: Response) => {
    try {
      const { destinationChannel, destinationDevice } = req.body ?? {};
      await monitor.clearCrosspoint(destinationChannel, destinationDevice);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  }));

  return router;
}
