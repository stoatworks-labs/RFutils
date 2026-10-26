/**
 * Internal RF-coordination data model that every reader/writer converts to
 * and from. Ported from wsm-wwb-bridge's model.py — one `Channel` is one
 * coordinated RF channel (one mic/beltpack frequency); a `CoordinationList`
 * is a full set, e.g. one show or one venue's plan.
 */

import { formatMhz } from './formats/freqParse.js';

export interface Channel {
  name: string;
  frequencyMhz: number;
  group?: string | null;
  channel?: string | null;
  deviceType?: string | null;
  manufacturer?: string | null;
  notes?: string | null;
  zone?: string | null;
  inclusionGroup?: string | null;
  isBackup?: boolean | null;
}

export interface CoordinationList {
  channels: Channel[];
  /** e.g. "wwb-shw", "wsm-project", "pmse-licence" — how it was read in. */
  sourceFormat?: string | null;
}

/** Three-decimal MHz, rounded exactly as wsm-wwb-bridge rounds it (see formatMhz). */
export function displayFrequency(ch: Channel): string {
  return formatMhz(ch.frequencyMhz);
}

export function emptyList(sourceFormat?: string): CoordinationList {
  return { channels: [], sourceFormat: sourceFormat ?? null };
}

/**
 * The set of detected/importable input shapes, mirroring wsm-wwb-bridge's
 * detect_format() return values plus the PMSE licence PDF.
 */
/** Internal Channel fields a generic CSV column can map onto. */
export type ChannelField =
  | 'name'
  | 'frequencyMhz'
  | 'group'
  | 'channel'
  | 'deviceType'
  | 'manufacturer'
  | 'notes'
  | 'zone';

/** header-column-index (or null when unmapped) for each Channel field. */
export type FieldMapping = Partial<Record<ChannelField, number | null>>;

export type DetectedFormat =
  | 'wwb-xml'
  | 'wsm-xml'
  | 'wsm-html'
  | 'wsm'
  | 'wwb-report'
  | 'wwb-frequency-list'
  | 'pmse-pdf'
  | 'generic';

/** Every output format the suite can write. */
export type ExportFormat =
  | 'wwb-frequency-list'
  | 'wwb-inventory-csv'
  | 'wsm-csv'
  | 'generic-csv'
  | 'wwb-shw';

export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  extension: string;
  mimeType: string;
  /** Reverse-engineered / experimental formats are flagged for the UI. */
  experimental?: boolean;
  note?: string;
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  {
    id: 'wwb-frequency-list',
    label: 'WWB frequency list (.txt)',
    extension: 'txt',
    mimeType: 'text/plain',
    note: "Shure's documented 'Import Frequencies from File' format — the safe option.",
  },
  {
    id: 'wwb-inventory-csv',
    label: 'WWB inventory (.csv)',
    extension: 'csv',
    mimeType: 'text/csv',
    note: 'Best-effort structured export; WWB inventory columns are user-configurable.',
  },
  {
    id: 'wsm-csv',
    label: 'WSM Frequencies/Bands (.csv)',
    extension: 'csv',
    mimeType: 'text/csv',
    note: 'Import as a candidate pool, then run WSM coordination. Every frequency comes in at Medium priority.',
  },
  {
    id: 'generic-csv',
    label: 'Generic (.csv)',
    extension: 'csv',
    mimeType: 'text/csv',
    note: 'Full internal model as a plain CSV.',
  },
  {
    id: 'wwb-shw',
    label: 'WWB7 show file (.shw)',
    extension: 'shw',
    mimeType: 'application/xml',
    experimental: true,
    note: 'Reverse-engineered native show file — open in WWB and verify before a live show.',
  },
];
