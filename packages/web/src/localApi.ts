/**
 * In-browser implementations of the API calls that don't need a server.
 *
 * The hosted build (GitHub Pages) has no backend, so conversion, coordination
 * and the inventory run here instead. They call exactly the same code the
 * server calls — the parsers, the .shw generator and the coordination engine
 * all live in `@rfutils/shared` and touch no Node APIs — so a file converted in
 * the browser is byte-identical to one converted by the server.
 *
 * What can't move: device discovery (mDNS/UDP), live monitoring (WebSocket to
 * the server) and programming receivers (raw TCP). A page can't open those
 * sockets, so `staticBuild` hides those tabs rather than faking them.
 *
 * The heavy modules are imported dynamically: pdfjs in particular is large and
 * only needed once somebody actually drops a licence PDF in.
 */

import type {
  AnalysisResult,
  CoordinationList,
  CoordinationParams,
  CoordinationRadio,
  CoordinationResult,
  ExportFormat,
  FieldMapping,
  Inventory,
  InventoryItem,
  PmseConversion,
  ProfileCatalog,
} from '@rfutils/shared';
import { EXPORT_FORMATS, builtinCatalog, classifyUpload, emptyInventory } from '@rfutils/shared';
import type { UploadReadResult } from '@rfutils/shared/formats';
import { isPdfFile, type ConvertResponse } from './api.js';

/** Strip a UTF-8 BOM, as the server's `decodeText` does. */
function decodeText(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function convertFileLocal(
  file: File,
  mapping?: FieldMapping
): Promise<ConvertResponse> {
  if (await isPdfFile(file)) {
    // Mirrors the server's 415: the Convert tab routes PDFs to
    // convertPmsePdfLocal before it gets here, so this only fires for a
    // direct caller.
    throw new Error('This is a PDF. Ofcom PMSE licence schedules go through convertPmsePdf.');
  }
  const { readUpload } = await import('@rfutils/shared/formats');
  const text = decodeText(await file.text());

  let read: UploadReadResult;
  try {
    read = readUpload(text, mapping);
  } catch (err) {
    throw new Error(`Could not parse this file: ${(err as Error).message}`, { cause: err });
  }
  return {
    ...read,
    filename: file.name,
    channelCount: read.list.channels.length,
    exportFormats: EXPORT_FORMATS,
  };
}

export async function exportModelLocal(
  list: CoordinationList,
  format: ExportFormat
): Promise<Blob> {
  const info = EXPORT_FORMATS.find((f) => f.id === format);
  if (!info) throw new Error(`Unknown export format: ${format}`);

  let content: string;
  if (format === 'wwb-shw') {
    // Same delegation the server route makes: .shw comes from the show
    // generator, not the format writers.
    const { generateShow } = await import('@rfutils/shared/pmse');
    content = generateShow(
      list.channels.map((c) => ({ frequencyMhz: c.frequencyMhz, suggestedName: c.name })),
      { showName: 'RFutils Export' }
    );
  } else {
    const { writeFormat } = await import('@rfutils/shared/formats');
    content = writeFormat(list, format);
  }
  return new Blob([content], { type: info.mimeType });
}

/**
 * pdfjs needs its worker script, and in a bundled build that URL has to be
 * handed to it explicitly or it falls back to running on the main thread.
 *
 * The file is copied into the output by the `rfutils-pdf-worker` plugin in
 * vite.config.ts rather than imported with `?url`: an `?url` import emits the
 * 2.3 MB worker even into the server build, where this whole module is dead
 * code. Copying it only in the static build keeps that bundle clean.
 */
let workerConfigured = false;
async function configurePdfWorker(): Promise<void> {
  if (workerConfigured) return;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.mjs`;
  workerConfigured = true;
}

export async function convertPmsePdfLocal(file: File): Promise<PmseConversion> {
  const data = new Uint8Array(await file.arrayBuffer());
  if (classifyUpload(data, file.name, file.type) !== 'pdf') {
    throw new Error('Please upload a PDF file.');
  }

  await configurePdfWorker();
  const { convertLicence } = await import('@rfutils/shared/pmse');

  let conversion: PmseConversion;
  try {
    conversion = await convertLicence(data);
  } catch (err) {
    throw new Error(`Could not parse this PDF: ${(err as Error).message}`, { cause: err });
  }
  if (conversion.assignmentCount === 0) {
    throw new Error(
      'No frequency assignments were found in this PDF. It may not be an Ofcom PMSE licence schedule.'
    );
  }
  return conversion;
}

export async function coordinateFrequenciesLocal(
  count: number,
  params: CoordinationParams,
  names?: string[]
): Promise<CoordinationResult> {
  const { coordinate } = await import('@rfutils/shared/coordination');
  return coordinate(count, params, names);
}

export async function coordinateRadioSetLocal(
  radios: CoordinationRadio[],
  params: CoordinationParams
): Promise<CoordinationResult> {
  const { coordinateRadios } = await import('@rfutils/shared/coordination');
  return coordinateRadios(radios, params);
}

export async function analyzeFrequenciesLocal(
  frequencies: number[],
  params: CoordinationParams
): Promise<AnalysisResult> {
  const { analyze } = await import('@rfutils/shared/coordination');
  return analyze(frequencies, params);
}

/**
 * The server merges built-in profiles with band presets from
 * ~/.rfutils/profiles.json. There is no such file in a browser, so the hosted
 * build gets the built-in catalog only.
 */
export async function getProfilesLocal(): Promise<ProfileCatalog> {
  return builtinCatalog();
}

// --- Inventory (localStorage stands in for ~/.rfutils/inventory.json) -------

const INVENTORY_KEY = 'rfutils.inventory';

export async function getInventoryLocal(): Promise<Inventory> {
  try {
    const raw = localStorage.getItem(INVENTORY_KEY);
    if (!raw) return emptyInventory();
    const parsed = JSON.parse(raw) as Inventory;
    if (!parsed || !Array.isArray(parsed.items)) return emptyInventory();
    return parsed;
  } catch {
    return emptyInventory();
  }
}

export async function putInventoryLocal(items: InventoryItem[]): Promise<Inventory> {
  const inv: Inventory = { items, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(INVENTORY_KEY, JSON.stringify(inv));
  } catch (err) {
    throw new Error(`Could not save the inventory in this browser: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return inv;
}
