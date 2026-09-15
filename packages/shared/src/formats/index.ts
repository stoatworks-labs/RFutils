/**
 * Format registry: reads any supported text input into the internal
 * CoordinationList model, and writes the model out to any export format.
 * This is the TS equivalent of what wsm-wwb-bridge's GUI dispatched to.
 */

import type { CoordinationList, DetectedFormat, ExportFormat } from '../index.js';
import { emptyList } from '../index.js';
import { detectFormat } from './detect.js';
import { readWwbXml } from './wwbXml.js';
import { readWsmProject } from './wsmXml.js';
import { readWsmHtmlReport } from './wsmHtml.js';
import { readWsmCsv } from './wsm.js';
import { readWwbReportCsv } from './wwbReport.js';
import { readWwbFile } from './wwb.js';
import {
  parseGenericCsv,
  readHeaderAndRows,
  sniffMapping,
  type FieldMapping,
} from './csvGeneric.js';
import { writeWwbFrequencyList, writeWwbInventoryCsv } from './wwb.js';
import { writeWsmCsv } from './wsm.js';
import { writeGenericCsv } from './csvGeneric.js';

export { detectFormat };
export * from './csvGeneric.js';
export * from './freqParse.js';

export interface ReadResult {
  format: DetectedFormat;
  list: CoordinationList;
}

/**
 * Read a text file into the model, auto-detecting the format. If `mapping`
 * is supplied it is used for generic CSV (the column-map dialog case).
 */
export function readText(text: string, mapping?: FieldMapping): ReadResult {
  return readAs(detectFormat(text), text, mapping);
}

export interface UploadReadResult extends ReadResult {
  /** Generic CSV only: the header row, for the column-map dialog. */
  header?: string[];
  /** Generic CSV only: the best guess at which column is which. */
  suggestedMapping?: FieldMapping;
}

/**
 * Everything the Convert tab needs from one text upload: the parsed list,
 * plus — for a generic CSV — the header and a suggested column mapping so
 * the UI can offer its column-map dialog.
 *
 * A generic CSV whose header matches none of the known aliases cannot be
 * parsed until somebody maps it. With no `mapping` supplied that case comes
 * back as an empty list *with* the dialog's inputs rather than as an error,
 * because the dialog is how the user gets out of it. A mapping the user did
 * supply is allowed to fail, and the error says why.
 */
export function readUpload(text: string, mapping?: FieldMapping): UploadReadResult {
  const format = detectFormat(text);
  if (format !== 'generic') return readAs(format, text, mapping);

  const { header } = readHeaderAndRows(text);
  const suggestedMapping = sniffMapping(header);
  const nothingToGoOn =
    !mapping && suggestedMapping.name == null && suggestedMapping.frequencyMhz == null;
  const list = nothingToGoOn ? emptyList('generic-csv') : parseGenericCsv(text, mapping);
  return { format, list, header, suggestedMapping };
}

function readAs(format: DetectedFormat, text: string, mapping?: FieldMapping): ReadResult {
  switch (format) {
    case 'wwb-xml':
      return { format, list: readWwbXml(text) };
    case 'wsm-xml':
      return { format, list: readWsmProject(text) };
    case 'wsm-html':
      return { format, list: readWsmHtmlReport(text) };
    case 'wsm':
      return { format, list: readWsmCsv(text) };
    case 'wwb-report':
      return { format, list: readWwbReportCsv(text) };
    case 'wwb-frequency-list':
      return { format, list: readWwbFile(text) };
    case 'generic':
    default:
      return { format: 'generic', list: parseGenericCsv(text, mapping) };
  }
}

export function writeFormat(list: CoordinationList, format: ExportFormat): string {
  switch (format) {
    case 'wwb-frequency-list':
      return writeWwbFrequencyList(list);
    case 'wwb-inventory-csv':
      return writeWwbInventoryCsv(list);
    case 'wsm-csv':
      return writeWsmCsv(list);
    case 'generic-csv':
      return writeGenericCsv(list);
    case 'wwb-shw':
      // Delegated to the PMSE show generator (which builds a full .shw from
      // frequencies/names); wired in via the server route to avoid a cycle.
      throw new Error('wwb-shw export is produced by the show generator');
  }
}
