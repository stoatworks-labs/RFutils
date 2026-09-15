import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readText, readUpload, writeFormat } from '@rfutils/shared/formats';
import { detectFormat } from '@rfutils/shared/formats';
import { parseFrequencyToMhz, formatKhz, parseWwbGroupChannel } from '@rfutils/shared/formats';
import { generateShow } from '@rfutils/shared/pmse';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

// Expected format + channel counts, taken from the original wsm-wwb-bridge
// tool's output on these exact real exports.
const CASES: Array<[string, string, number]> = [
  ['wwb_show.shw', 'wwb-xml', 44],
  ['wwb_workspace.cws', 'wwb-xml', 291],
  ['wsm_project.wsm', 'wsm-xml', 11],
  ['wsm_report.html', 'wsm-html', 11],
  ['wsm_frequencies_bands.csv', 'wsm', 1],
  ['wsm_discrete_frequency.csv', 'wsm', 1],
  ['wwb_coordination_report.csv', 'wwb-report', 291],
];

describe('format detection + parsing against real vendor exports', () => {
  for (const [file, format, count] of CASES) {
    it(`${file} → ${format}, ${count} channels`, () => {
      const text = read(file);
      expect(detectFormat(text)).toBe(format);
      const { list } = readText(text);
      expect(list.channels.length).toBe(count);
      // every channel has a positive, finite frequency
      for (const ch of list.channels) {
        expect(Number.isFinite(ch.frequencyMhz)).toBe(true);
        expect(ch.frequencyMhz).toBeGreaterThan(0);
      }
    });
  }
});

describe('re-export round-trips', () => {
  it('WSM HTML report → WWB frequency list has one line per channel', () => {
    const { list } = readText(read('wsm_report.html'));
    const out = writeFormat(list, 'wwb-frequency-list');
    const lines = out.trim().split('\n');
    expect(lines.length).toBe(list.channels.length);
    expect(lines[0]).toMatch(/^\d+\.\d{3}$/);
  });

  it('WSM CSV export uses kHz and the documented header', () => {
    const { list } = readText(read('wsm_report.html'));
    const out = writeFormat(list, 'wsm-csv');
    expect(out.split('\r\n')[0]).toBe(
      'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel'
    );
    // 470.5 MHz -> 470500 kHz
    expect(out).toContain('470500');
  });
});

describe('freqParse', () => {
  it('normalises MHz, kHz, and comma-decimal notations', () => {
    expect(parseFrequencyToMhz('470.100')).toBeCloseTo(470.1, 3);
    expect(parseFrequencyToMhz('600768')).toBeCloseTo(600.768, 3);
    expect(parseFrequencyToMhz('600,768')).toBeCloseTo(600.768, 3);
    expect(formatKhz(470.5)).toBe('470500');
  });
  it('parses WWB group/channel forms', () => {
    expect(parseWwbGroupChannel('G:12 Ch:4')).toEqual(['12', '4']);
    expect(parseWwbGroupChannel('--,--')).toEqual([null, null]);
    expect(parseWwbGroupChannel('7,3')).toEqual(['7', '3']);
  });
});

describe('.shw show generator', () => {
  it('groups assignments into AD4Q-A quad receivers and substitutes frequencies', () => {
    const shw = generateShow(
      [
        { frequencyMhz: 470.1, suggestedName: 'A' },
        { frequencyMhz: 471.2, suggestedName: 'B' },
      ],
      { showName: 'Test', now: new Date(2026, 0, 1, 0, 0, 0) }
    );
    expect(shw).toContain('<show ');
    expect(shw).toContain('470100'); // 470.1 MHz in kHz
    expect(shw).toContain('471200');
    expect(shw).toContain('<name>Test</name>');
  });
});

describe('readUpload: what the Convert tab gets from one text file', () => {
  // Headers that match none of the aliases — the case that needs the dialog most.
  const odd = 'Mic,Carrier [MHz],Pack\nLead vox,606.1,HH1\nGtr,607.7,BP2\n';

  it('returns the dialog inputs instead of failing when nothing can be guessed', () => {
    const r = readUpload(odd);
    expect(r.format).toBe('generic');
    expect(r.list.channels).toEqual([]);
    expect(r.header).toEqual(['Mic', 'Carrier [MHz]', 'Pack']);
    expect(r.suggestedMapping?.name).toBeNull();
    expect(r.suggestedMapping?.frequencyMhz).toBeNull();
    // readText, the strict reader, still refuses the same input
    expect(() => readText(odd)).toThrow(/name or frequency/);
  });

  it('parses the same file once the user has mapped it', () => {
    const r = readUpload(odd, { name: 0, frequencyMhz: 1, channel: 2 });
    expect(r.list.channels.map((c) => [c.name, c.frequencyMhz, c.channel])).toEqual([
      ['Lead vox', 606.1, 'HH1'],
      ['Gtr', 607.7, 'BP2'],
    ]);
    expect(r.header).toEqual(['Mic', 'Carrier [MHz]', 'Pack']);
  });

  it('lets a mapping the user supplied fail loudly', () => {
    expect(() => readUpload(odd, { name: null, frequencyMhz: null })).toThrow(/name or frequency/);
  });

  it('still parses a generic CSV whose header it can guess', () => {
    const r = readUpload('Name,Frequency (MHz)\nLead,606.100\n');
    expect(r.format).toBe('generic');
    expect(r.list.channels).toHaveLength(1);
    expect(r.suggestedMapping).toMatchObject({ name: 0, frequencyMhz: 1 });
  });

  it('carries no dialog inputs for a recognised vendor format', () => {
    const r = readUpload(read('wsm_report.html'));
    expect(r.format).toBe('wsm-html');
    expect(r.list.channels).toHaveLength(11);
    expect(r.header).toBeUndefined();
    expect(r.suggestedMapping).toBeUndefined();
  });
});
