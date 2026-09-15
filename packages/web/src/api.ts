/**
 * Browser-side client for the RFutils server. Replaces MicWizard's Electron
 * `window.micMonitor` IPC bridge: file conversion + Companion actions go over
 * REST (/api), live device state arrives over a WebSocket (/ws).
 *
 * In the static build (`VITE_RFUTILS_STATIC=1`, what GitHub Pages serves) there
 * is no server to talk to, so everything that can run in the browser is routed
 * to `localApi` instead — same shared code the server would have run. The
 * LAN-only calls below still throw; the tabs that use them aren't rendered.
 */

import type {
  CompanionStatus,
  CoordinationList,
  CrosspointRequest,
  DetectedFormat,
  ExportFormat,
  ExportFormatInfo,
  FieldMapping,
  PmseConversion,
  ServerToClientEvent,
  CoordinationParams,
  CoordinationRadio,
  CoordinationResult,
  AnalysisResult,
  Inventory,
  InventoryItem,
  DiscoveredDevice,
  ProfileCatalog,
} from '@rfutils/shared';
import { classifyUpload } from '@rfutils/shared';
import { staticBuild } from './buildMode.js';

/** The browser-side implementations, loaded only by the static build. */
const local = () => import('./localApi.js');

/** Thrown by the calls that need the local RFutils server (LAN discovery,
 * live monitoring, programming receivers) when running as a hosted page. */
function noServer(feature: string): never {
  throw new Error(
    `${feature} needs the RFutils server on your own network — it can't run in a hosted page. ` +
      'Download RFutils and run it locally.'
  );
}

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

/**
 * Which converter a dropped file belongs to — the server's `isPdfUpload`, on
 * a File. Peeks at the first KiB, where a PDF header has to sit, so the
 * Convert tab can route a licence to `convertPmsePdf` and everything else to
 * `convertFile` without asking the user which it is.
 */
export async function isPdfFile(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  return classifyUpload(head, file.name, file.type) === 'pdf';
}

export interface ConvertResponse {
  format: DetectedFormat;
  filename: string;
  channelCount: number;
  list: CoordinationList;
  exportFormats: ExportFormatInfo[];
  header?: string[];
  suggestedMapping?: FieldMapping;
}

export async function convertFile(file: File, mapping?: FieldMapping): Promise<ConvertResponse> {
  if (staticBuild) return (await local()).convertFileLocal(file, mapping);
  const form = new FormData();
  form.append('file', file);
  if (mapping) form.append('mapping', JSON.stringify(mapping));
  return asJson<ConvertResponse>(await fetch('/api/convert', { method: 'POST', body: form }));
}

export async function exportModel(list: CoordinationList, format: ExportFormat): Promise<Blob> {
  if (staticBuild) return (await local()).exportModelLocal(list, format);
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ list, format }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Export failed (${res.status})`);
  }
  return res.blob();
}

export async function convertPmsePdf(file: File): Promise<PmseConversion> {
  if (staticBuild) return (await local()).convertPmsePdfLocal(file);
  const form = new FormData();
  form.append('file', file);
  return asJson<PmseConversion>(await fetch('/api/pmse/convert', { method: 'POST', body: form }));
}

export async function coordinateFrequencies(
  count: number,
  params: CoordinationParams,
  names?: string[]
): Promise<CoordinationResult> {
  if (staticBuild) return (await local()).coordinateFrequenciesLocal(count, params, names);
  return asJson<CoordinationResult>(
    await fetch('/api/coordinate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, params, names }),
    })
  );
}

/**
 * Coordinate a set of radios that each carry their own tuning ranges, raster
 * and required spacing — the path that uses the equipment catalog's real
 * numbers rather than one global spacing guess.
 */
export async function coordinateRadioSet(
  radios: CoordinationRadio[],
  params: CoordinationParams
): Promise<CoordinationResult> {
  if (staticBuild) return (await local()).coordinateRadioSetLocal(radios, params);
  return asJson<CoordinationResult>(
    await fetch('/api/coordinate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radios, params }),
    })
  );
}

export async function analyzeFrequencies(
  frequencies: number[],
  params: CoordinationParams
): Promise<AnalysisResult> {
  if (staticBuild) return (await local()).analyzeFrequenciesLocal(frequencies, params);
  return asJson<AnalysisResult>(
    await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequencies, params }),
    })
  );
}

export async function getProfiles(): Promise<ProfileCatalog> {
  if (staticBuild) return (await local()).getProfilesLocal();
  return asJson<ProfileCatalog>(await fetch('/api/profiles'));
}

export async function getInventory(): Promise<Inventory> {
  if (staticBuild) return (await local()).getInventoryLocal();
  return asJson<Inventory>(await fetch('/api/inventory'));
}

export async function putInventory(items: InventoryItem[]): Promise<Inventory> {
  if (staticBuild) return (await local()).putInventoryLocal(items);
  return asJson<Inventory>(
    await fetch('/api/inventory', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
  );
}

export async function getDevices(): Promise<DiscoveredDevice[]> {
  if (staticBuild) noServer('Device discovery');
  const r = await asJson<{ devices: DiscoveredDevice[] }>(await fetch('/api/devices'));
  return r.devices;
}

export interface ProgramTargetResult {
  channelId: string;
  address: string;
  command: string;
  sent: boolean;
  ok: boolean;
  reply?: string;
  error?: string;
}

export async function programFrequencies(
  targets: Array<{ channelId: string; frequencyMhz: number }>,
  dryRun: boolean
): Promise<{ dryRun: boolean; results: ProgramTargetResult[] }> {
  if (staticBuild) noServer('Programming receivers');
  return asJson(
    await fetch('/api/program', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, dryRun }),
    })
  );
}

export async function companionStatus(): Promise<CompanionStatus> {
  if (staticBuild) noServer('Companion routing');
  return asJson<CompanionStatus>(await fetch('/api/companion/status'));
}

export interface AudioModeInfo {
  mode: 'capture' | 'direct';
  cueBusConfigured: boolean;
}

export async function audioMode(): Promise<AudioModeInfo> {
  if (staticBuild) noServer('Audio monitoring');
  return asJson<AudioModeInfo>(await fetch('/api/audio/mode'));
}

export async function makeCrosspoint(request: CrosspointRequest): Promise<void> {
  if (staticBuild) noServer('Companion routing');
  await asJson(
    await fetch('/api/companion/make-crosspoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  );
}

export async function clearCrosspoint(
  destinationChannel: string,
  destinationDevice: string
): Promise<void> {
  if (staticBuild) noServer('Companion routing');
  await asJson(
    await fetch('/api/companion/clear-crosspoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationChannel, destinationDevice }),
    })
  );
}

/**
 * Subscribe to live device events over WebSocket. Reconnects automatically.
 * Returns a disconnect function.
 */
export function connectDeviceSocket(
  onEvent: (event: ServerToClientEvent) => void,
  onOpenChange?: (open: boolean) => void
): () => void {
  if (staticBuild) return () => {};
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => onOpenChange?.(true);
    socket.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as ServerToClientEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      onOpenChange?.(false);
      if (!closed) retry = setTimeout(open, 2000);
    };
    socket.onerror = () => socket?.close();
  };
  open();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
