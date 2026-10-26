/**
 * Sennheiser Wireless Systems Manager (WSM) "Frequencies/Bands" CSV.
 * Ported from wsm-wwb-bridge/wsm.py.
 *
 *   name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel
 *
 * Semicolon-delimited, lowercase headers, frequencies in kHz. This is a
 * candidate frequency *pool*, not per-channel coordinated assignments — see
 * wsmXml/wsmHtml for real per-channel data. type=0 is a discrete frequency
 * (the only kind this tool writes).
 */

import type { Channel, CoordinationList } from '../index.js';
import { formatKhz, parseFrequencyToMhz } from './freqParse.js';
import { parseCsv, writeCsv } from './csvUtil.js';

const DEFAULT_TYPE = '0'; // confirmed: discrete frequency, verified against a real WSM export
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

export function writeWsmCsv(list: CoordinationList): string {
  const rows: (string | number)[][] = [HEADER];
  for (const ch of list.channels) {
    const freqKhz = formatKhz(ch.frequencyMhz);
    rows.push([
      ch.name,
      ch.deviceType ?? DEFAULT_TYPE,
      freqKhz,
      '0',
      freqKhz, // min == max == frequency: a zero-width "discrete" range
      freqKhz,
      '3',
      '5',
    ]);
  }
  return writeCsv(rows, DELIMITER);
}
