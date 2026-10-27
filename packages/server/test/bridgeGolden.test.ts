/**
 * Golden outputs from wsm-wwb-bridge itself.
 *
 * bridge-golden/ holds inputs the bridge publishes in its own
 * repository (its sample_data/ files and the documents inlined in its tests)
 * plus two small synthetic files for the known parity edges, each beside the
 * <name>.expected.json the bridge's Python produced for it: the detected
 * format, the parsed channel list, and the text of all four writers. This
 * asserts RFutils produces exactly the same — byte for byte for the writers.
 *
 * Regenerate with bridge-golden/generate.py (it says how). The bridge
 * is retired in favour of RFutils, so a difference here is now a decision to
 * diverge, not drift; record it rather than regenerate it away.
 *
 * Divergences, edited into the expected outputs by hand (a regenerate undoes them):
 *
 * - wsm-csv (PR #90): every row ends in priority 2 and squelchlevel 5, where the
 *   bridge left both empty and WSM 4.9.0 refused the import. The type column
 *   keeps only WSM's own numeric codes; a model or band name ("ULXD2", "G56")
 *   is written as 0, a discrete frequency. Lines end in LF, as in WSM's own
 *   export, where the bridge wrote CRLF. See formats/wsm.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { Channel, ExportFormat } from '@rfutils/shared';
import { detectFormat, readText, writeFormat } from '@rfutils/shared/formats';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'bridge-golden');

interface Expected {
  input: string;
  format: string;
  error?: string;
  list?: { sourceFormat: string; channels: Record<string, unknown>[] };
  outputs?: Record<string, string>;
}

const FIELDS = [
  'name',
  'frequencyMhz',
  'group',
  'channel',
  'deviceType',
  'manufacturer',
  'notes',
  'zone',
  'inclusionGroup',
  'isBackup',
] as const;

/** Python's dataclass has every field, None when unset; the TS model leaves them off. */
function normalise(ch: Channel): Record<string, unknown> {
  return Object.fromEntries(FIELDS.map((f) => [f, ch[f] ?? null]));
}

const cases = readdirSync(DIR)
  .filter((f) => f.endsWith('.expected.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Expected);

describe('bridge golden outputs', () => {
  it('has the fixtures it expects', () => {
    expect(cases.length).toBeGreaterThanOrEqual(18);
  });

  for (const expected of cases) {
    describe(expected.input, () => {
      let text = readFileSync(join(DIR, expected.input), 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // the bridge reads utf-8-sig

      it(`detects as ${expected.format}`, () => {
        expect(detectFormat(text)).toBe(expected.format);
      });

      if (expected.error) {
        it('fails to read, as the bridge does', () => {
          expect(() => readText(text)).toThrow();
        });
        return;
      }

      it('reads the same channels', () => {
        const { list } = readText(text);
        expect(list.sourceFormat).toBe(expected.list!.sourceFormat);
        expect(list.channels.map(normalise)).toEqual(expected.list!.channels);
      });

      for (const [format, output] of Object.entries(expected.outputs!)) {
        it(`writes ${format} byte for byte`, () => {
          const { list } = readText(text);
          expect(writeFormat(list, format as ExportFormat)).toBe(output);
        });
      }
    });
  }
});
