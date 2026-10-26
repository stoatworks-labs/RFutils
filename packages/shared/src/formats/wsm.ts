/**
 * Sennheiser Wireless Systems Manager (WSM) "Frequencies/Bands" CSV.
 * Ported from wsm-wwb-bridge/wsm.py; the bridge is retired and this is the
 * canonical copy.
 *
 *   name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel
 *
 * Semicolon-delimited, lowercase headers, frequencies in kHz. This is a
 * candidate frequency *pool*, not per-channel coordinated assignments — see
 * wsmXml/wsmHtml for real per-channel data. type=0 is a discrete frequency,
 * which is what this tool writes unless the list came from a WSM CSV and
 * carries one of its own numeric type codes.
 *
 * Unlike the bridge, the writer fills priority and squelchlevel: WSM 4.9.0
 * refuses to import the list when they are empty (RFutils PR #90). The values
 * are the ones WSM's own export writes for a discrete frequency left at its
 * defaults (test/fixtures/wsm_discrete_frequency.csv). Sennheiser's WSM 4.9.0
 * help ("Setting frequencies/frequency bands", "Exporting frequency lists"):
 * https://sennheiser.com/globalassets/digizuite/51140-en-wsm_software_help_4.9.0_en.pdf
 */

import type { Channel, CoordinationList } from '../index.js';
import { formatKhz, parseFrequencyToMhz } from './freqParse.js';
import { parseCsv, writeCsv } from './csvUtil.js';

const DEFAULT_TYPE = '0'; // confirmed: discrete frequency, verified against a real WSM export
// "Medium", the help's default for a discrete frequency. Its dialog offers
// High, Medium, Low and Blocked; PR #90 reports 1 = Low and 3 = High.
const DEFAULT_PRIORITY = '2';
// The help calls this column the noise level. Its dialog shows the default as
// -102 dBm and the export writes 5, so it is presumably dBµV (-102 dBm + 107).
const DEFAULT_SQUELCH_LEVEL = '5';
const DELIMITER = ';';

const HEADER = [
  'name',
  'type',
  'frequency',
  'tolerance',
  'minfrequency',
  'maxfrequency',
  'priority',
  'squelchlevel',
];

function looksLikeWsmHeader(row: string[]): boolean {
  if (!row.length) return false;
  return row[0]!.trim().toLowerCase() === 'name' && row.length >= 3;
}

export function readWsmCsv(text: string): CoordinationList {
  // WSM's importer tolerates several delimiters; try semicolon first
  // (its own export format), then fall back to whatever is present.
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  let delimiter: string;
  if (firstLine.includes(DELIMITER)) {
    delimiter = DELIMITER;
  } else {
    delimiter = ';';
    for (const candidate of [';', '|', ':', '\t', ',']) {
      if (text.includes(candidate)) {
        delimiter = candidate;
        break;
      }
    }
  }

  let rows = parseCsv(text, delimiter).filter((row) => row.some((c) => c.trim() !== ''));
  if (rows.length && looksLikeWsmHeader(rows[0]!)) {
    rows = rows.slice(1);
  }

  const channels: Channel[] = [];
  for (const row of rows) {
    if (row.length < 3) continue;
    const name = row[0]!.trim() || `CH ${channels.length + 1}`;
    const typeCode = row[1]!.trim() || null;
    let freqMhz: number;
    try {
      freqMhz = parseFrequencyToMhz(row[2]!);
    } catch {
      continue;
    }
    channels.push({ name, frequencyMhz: freqMhz, deviceType: typeCode });
  }
  return { channels, sourceFormat: 'wsm-csv' };
}

/**
 * WSM's type is a numeric code (0 discrete frequency and 2 usable band in the
 * real exports). A model or band name from another format ("ULXD2", "G56") is
 * not one, so that row is written as a discrete frequency.
 */
function wsmType(deviceType: string | null | undefined): string {
  return deviceType && /^\d+$/.test(deviceType) ? deviceType : DEFAULT_TYPE;
}

export function writeWsmCsv(list: CoordinationList): string {
  const rows: (string | number)[][] = [HEADER];
  for (const ch of list.channels) {
    const freqKhz = formatKhz(ch.frequencyMhz);
    rows.push([
      ch.name,
      wsmType(ch.deviceType),
      freqKhz,
      '0',
      freqKhz, // min == max == frequency: a zero-width "discrete" range
      freqKhz,
      DEFAULT_PRIORITY,
      DEFAULT_SQUELCH_LEVEL,
    ]);
  }
  return writeCsv(rows, DELIMITER);
}
