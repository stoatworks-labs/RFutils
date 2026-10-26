/**
 * wsm-wwb-bridge's own unit tests, ported assertion for assertion.
 *
 * Each describe block is one of the bridge's tests/test_*.py modules, each `it`
 * one of its test methods, with the same inputs and expectations. The sample
 * documents those tests inline are read from bridge-golden/, where
 * generate.py wrote them out of the bridge's test modules verbatim.
 *
 * Left out, because the TS model has no equivalent: the dataclass defaults,
 * len() and iteration checks in test_model.py (a CoordinationList here is a
 * plain { channels } object).
 *
 * Changed on purpose: write_wsm_csv's discrete row ends in ";2;5", not ";;",
 * because WSM 4.9.0 will not import a list with those columns empty (PR #90).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { Channel, CoordinationList, FieldMapping } from '@rfutils/shared';
import { displayFrequency, emptyList } from '@rfutils/shared';
import {
  detectFormat,
  formatKhz,
  formatMhz,
  looksLikeBareFrequencyList,
  looksLikeWsmHtmlReport,
  looksLikeWsmXml,
  looksLikeWwbReport,
  looksLikeWwbXml,
  parseFrequencyToMhz,
  parseWwbGroupChannel,
  readHeaderAndRows,
  readRows,
  readWsmCsv,
  readWsmHtmlReport,
  readWsmProject,
  readWwbFile,
  readWwbReportCsv,
  readWwbXml,
  sniffDelimiter,
  sniffMapping,
  writeGenericCsv,
  writeWsmCsv,
  writeWwbFrequencyList,
  writeWwbInventoryCsv,
} from '@rfutils/shared/formats';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'bridge-golden');
const sample = (name: string): string => {
  const text = readFileSync(join(GOLDEN, name), 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const SAMPLE_SHW = sample('test_wwb_xml.SAMPLE_SHW.shw');
const SAMPLE_SHW_NO_INVENTORY = sample('test_wwb_xml.SAMPLE_SHW_NO_INVENTORY.shw');
const SAMPLE_CWS = sample('test_wwb_xml.SAMPLE_CWS.cws');
const SAMPLE_WSM = sample('test_wsm_xml.SAMPLE_WSM.wsm');
const SAMPLE_WSM_NO_COORDINATION = sample('test_wsm_xml.SAMPLE_WSM_NO_COORDINATION.wsm');
const SAMPLE_WSM_HTML = sample('test_wsm_html.SAMPLE_REPORT.html');
const SAMPLE_WWB_REPORT = sample('test_wwb_report.SAMPLE_REPORT.csv');

/** Python's assertAlmostEqual: equal to 7 decimal places. */
const almost = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 7);

/** The bridge's tests spell out every field; unmapped ones are None. */
const mapping = (m: FieldMapping): FieldMapping => ({
  name: null,
  frequencyMhz: null,
  group: null,
  channel: null,
  deviceType: null,
  manufacturer: null,
  notes: null,
  zone: null,
  ...m,
});

const list = (channels: Channel[]): CoordinationList => ({ channels });

describe('test_freq_parse: parse_frequency_to_mhz', () => {
  it('plain MHz decimal', () => almost(parseFrequencyToMhz('470.100'), 470.1));
  it('raw kHz integer', () => almost(parseFrequencyToMhz('470100'), 470.1));
  it('below the kHz threshold stays MHz', () => almost(parseFrequencyToMhz('2999'), 2999.0));
  it('at the kHz threshold converts', () => almost(parseFrequencyToMhz('3000'), 3.0));
  it('comma as decimal separator', () => almost(parseFrequencyToMhz('600,768'), 600.768));
  it('comma as thousands separator when a dot is present', () =>
    almost(parseFrequencyToMhz('1,234.5'), 1234.5));
  it('whitespace stripped', () => almost(parseFrequencyToMhz('  606.250  '), 606.25));
  it('empty string raises', () => expect(() => parseFrequencyToMhz('')).toThrow());
  it('whitespace only raises', () => expect(() => parseFrequencyToMhz('   ')).toThrow());
  it('non-numeric raises', () => expect(() => parseFrequencyToMhz('not-a-frequency')).toThrow());
});

describe('test_freq_parse: formatters', () => {
  it('format_mhz', () => expect(formatMhz(470.1)).toBe('470.100'));
  it('format_mhz rounds to three decimals', () => expect(formatMhz(470.12345)).toBe('470.123'));
  it('format_khz', () => expect(formatKhz(470.1)).toBe('470100'));
  it('format_khz rounds', () => expect(formatKhz(470.1234)).toBe('470123'));
  it('format_khz and parse round-trip', () => almost(parseFrequencyToMhz(formatKhz(606.25)), 606.25));

  // Not in the bridge's suite: the half-even behaviour its round() and
  // f-strings have, which RFutils now matches (see formatMhz).
  it('rounds an exact half to even, as Python does', () => {
    expect(formatMhz(512.0625)).toBe('512.062');
    expect(formatMhz(470.1875)).toBe('470.188');
    expect(formatKhz(512.0625)).toBe('512062');
    expect(formatKhz(470.1875)).toBe('470188');
  });
});

describe('test_freq_parse: parse_wwb_group_channel', () => {
  it('None input', () => expect(parseWwbGroupChannel(null)).toEqual([null, null]));
  it('empty string', () => expect(parseWwbGroupChannel('')).toEqual([null, null]));
  it('report style, unassigned', () =>
    expect(parseWwbGroupChannel('G:-- Ch:--')).toEqual([null, null]));
  it('report style, assigned', () => expect(parseWwbGroupChannel('G:1 Ch:2')).toEqual(['1', '2']));
  it('.shw style, unassigned', () => expect(parseWwbGroupChannel('--,--')).toEqual([null, null]));
  it('.shw style, assigned', () => expect(parseWwbGroupChannel('1,2')).toEqual(['1', '2']));
  it('.shw style with spaces', () => expect(parseWwbGroupChannel(' 3 , 4 ')).toEqual(['3', '4']));

  // Not in the bridge's suite: a space after the colon, where RFutils used to
  // return [null, "01"] and the bridge ("01", "05").
  it('report style with a space after each colon', () => {
    expect(parseWwbGroupChannel('G: 01 Ch: 05')).toEqual(['01', '05']);
    expect(parseWwbGroupChannel('G: -- Ch: --')).toEqual([null, null]);
  });
});

describe('test_model', () => {
  it('display_frequency formats three decimals', () =>
    expect(displayFrequency({ name: 'X', frequencyMhz: 606.25 })).toBe('606.250'));
  it('starts empty', () => expect(emptyList().channels).toHaveLength(0));
});

describe('test_csv_generic: sniff_delimiter', () => {
  it('comma', () => expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(','));
  it('semicolon', () => expect(sniffDelimiter('a;b;c\n1;2;3\n')).toBe(';'));
  it('tab', () => expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t'));
});

describe('test_csv_generic: read_header_and_rows', () => {
  it('basic', () => {
    const { delimiter, header, rows } = readHeaderAndRows('Name,Frequency\nCH1,470.100\nCH2,471.100\n');
    expect(delimiter).toBe(',');
    expect(header).toEqual(['Name', 'Frequency']);
    expect(rows).toEqual([
      ['CH1', '470.100'],
      ['CH2', '471.100'],
    ]);
  });

  it('blank lines skipped', () => {
    const { header, rows } = readHeaderAndRows('Name,Frequency\n\nCH1,470.100\n\n');
    expect(header).toEqual(['Name', 'Frequency']);
    expect(rows).toEqual([['CH1', '470.100']]);
  });

  it('empty text', () => {
    const { header, rows } = readHeaderAndRows('');
    expect(header).toEqual([]);
    expect(rows).toEqual([]);
  });
});

describe('test_csv_generic: sniff_mapping', () => {
  it('exact aliases', () => {
    expect(
      sniffMapping(['Name', 'Frequency', 'Group', 'Channel', 'Type', 'Manufacturer', 'Notes', 'Zone'])
    ).toEqual({
      name: 0,
      frequencyMhz: 1,
      group: 2,
      channel: 3,
      deviceType: 4,
      manufacturer: 5,
      notes: 6,
      zone: 7,
    });
  });

  it('alternate aliases', () => {
    const m = sniffMapping(['Talent', 'Freq (MHz)', 'Zone', 'Ch', 'Device', 'Brand']);
    expect(m.name).toBe(0);
    expect(m.frequencyMhz).toBe(1);
    expect(m.zone).toBe(2);
    expect(m.channel).toBe(3);
    expect(m.deviceType).toBe(4);
    expect(m.manufacturer).toBe(5);
  });

  it('unrecognised headers unmapped', () => {
    expect(Object.values(sniffMapping(['Foo', 'Bar'])).every((v) => v === null)).toBe(true);
  });

  it('case insensitive', () => {
    const m = sniffMapping(['NAME', 'FREQUENCY']);
    expect(m.name).toBe(0);
    expect(m.frequencyMhz).toBe(1);
  });
});

describe('test_csv_generic: read_rows', () => {
  it('basic mapping', () => {
    const cl = readRows(
      [
        ['Lead Vocal', '606.250', 'A', '1'],
        ['Host Mic', '614.100', 'A', '2'],
      ],
      mapping({ name: 0, frequencyMhz: 1, group: 2, channel: 3 })
    );
    expect(cl.channels).toHaveLength(2);
    const first = cl.channels[0]!;
    expect(first.name).toBe('Lead Vocal');
    almost(first.frequencyMhz, 606.25);
    expect(first.group).toBe('A');
    expect(first.channel).toBe('1');
  });

  it('missing name gets fallback', () => {
    const cl = readRows([['', '606.250']], mapping({ name: 0, frequencyMhz: 1 }));
    expect(cl.channels[0]!.name).toBe('CH 1');
  });

  it('row with unparseable frequency skipped', () => {
    const cl = readRows(
      [
        ['CH1', 'not-a-number'],
        ['CH2', '470.100'],
      ],
      mapping({ name: 0, frequencyMhz: 1 })
    );
    expect(cl.channels).toHaveLength(1);
    expect(cl.channels[0]!.name).toBe('CH2');
  });

  it('row with blank frequency skipped', () => {
    expect(readRows([['CH1', '']], mapping({ name: 0, frequencyMhz: 1 })).channels).toHaveLength(0);
  });

  it('no name or frequency mapped raises', () => {
    expect(() => readRows([['a', 'b']], mapping({}))).toThrow();
  });

  it('short row missing columns handled', () => {
    const cl = readRows([['CH1', '470.100']], mapping({ name: 0, frequencyMhz: 1, group: 5 }));
    expect(cl.channels).toHaveLength(1);
    expect(cl.channels[0]!.group).toBeNull();
  });
});

describe('test_csv_generic: write_generic_csv', () => {
  it('round trip', () => {
    const text = writeGenericCsv(
      list([
        {
          name: 'Lead Vocal',
          frequencyMhz: 606.25,
          zone: 'A',
          group: '1',
          channel: '2',
          deviceType: 'ULXD2',
          manufacturer: 'Shure',
          notes: 'note',
        },
      ])
    );
    const { header, rows } = readHeaderAndRows(text);
    const back = readRows(rows, sniffMapping(header));
    expect(back.channels).toHaveLength(1);
    const ch = back.channels[0]!;
    expect(ch.name).toBe('Lead Vocal');
    almost(ch.frequencyMhz, 606.25);
    expect(ch.zone).toBe('A');
    expect(ch.group).toBe('1');
    expect(ch.channel).toBe('2');
    expect(ch.deviceType).toBe('ULXD2');
    expect(ch.manufacturer).toBe('Shure');
    expect(ch.notes).toBe('note');
  });
});

describe('test_wsm: read_wsm_csv', () => {
  const HEADER = 'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\n';

  it('real discrete frequency shape', () => {
    const cl = readWsmCsv(HEADER + 'Frequency 001;0;510100;0;510100;510100;2;5\n');
    expect(cl.channels).toHaveLength(1);
    const ch = cl.channels[0]!;
    expect(ch.name).toBe('Frequency 001');
    almost(ch.frequencyMhz, 510.1);
    expect(ch.deviceType).toBe('0');
  });

  it('real band shape', () => {
    const cl = readWsmCsv(HEADER + 'Band 001;2;705000;0;400000;4000000;2;5\n');
    expect(cl.channels).toHaveLength(1);
    almost(cl.channels[0]!.frequencyMhz, 705.0);
    expect(cl.channels[0]!.deviceType).toBe('2');
  });

  it('header row stripped', () => {
    const cl = readWsmCsv('name;type;frequency\nCH1;0;470100\n');
    expect(cl.channels).toHaveLength(1);
    expect(cl.channels[0]!.name).toBe('CH1');
  });

  it('no header still parses', () => {
    expect(readWsmCsv('CH1;0;470100\nCH2;0;471100\n').channels).toHaveLength(2);
  });

  it('blank lines ignored', () => {
    expect(readWsmCsv('name;type;frequency\nCH1;0;470100\n\n\n').channels).toHaveLength(1);
  });

  it('row missing name gets fallback', () => {
    expect(readWsmCsv('name;type;frequency\n;0;470100\n').channels[0]!.name).toBe('CH 1');
  });

  it('short row skipped', () => {
    expect(readWsmCsv('name;type;frequency\nCH1;0\n').channels).toHaveLength(0);
  });
});

describe('test_wsm: write_wsm_csv', () => {
  it('matches the real discrete shape', () => {
    const lines = writeWsmCsv(list([{ name: 'Frequency 001', frequencyMhz: 510.1 }])).split(/\r?\n/);
    expect(lines[0]).toBe(
      'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel'
    );
    expect(lines[1]).toBe('Frequency 001;0;510100;0;510100;510100;2;5');
  });

  it('default type is the verified discrete code', () => {
    expect(writeWsmCsv(list([{ name: 'X', frequencyMhz: 470 }]))).toContain('X;0;470000');
  });

  it('device type overrides default', () => {
    expect(writeWsmCsv(list([{ name: 'X', frequencyMhz: 470.0, deviceType: '7' }]))).toContain(
      'X;7;470000'
    );
  });

  it('round trip', () => {
    const back = readWsmCsv(
      writeWsmCsv(
        list([
          { name: 'Lead Vocal', frequencyMhz: 606.25 },
          { name: 'Host Mic', frequencyMhz: 614.1 },
        ])
      )
    );
    expect(back.channels).toHaveLength(2);
    almost(back.channels[0]!.frequencyMhz, 606.25);
    almost(back.channels[1]!.frequencyMhz, 614.1);
  });

  it('empty list produces header only', () => {
    const out = writeWsmCsv(list([]));
    expect(out.replace(/^\n+|\n+$/g, '').split('\n').length - 1).toBe(0);
  });
});

describe('test_wwb', () => {
  it('frequency list: one value per line, three decimals', () => {
    expect(
      writeWwbFrequencyList(
        list([
          { name: 'A', frequencyMhz: 470.1 },
          { name: 'B', frequencyMhz: 471.25 },
        ])
      )
    ).toBe('470.100\n471.250\n');
  });

  it('frequency list: empty list', () => expect(writeWwbFrequencyList(list([]))).toBe('\n'));

  it('bare list: all numeric rows', () =>
    expect(looksLikeBareFrequencyList([['470.100'], ['471.100']])).toBe(true));
  it('bare list: mixed named row rejected', () =>
    expect(looksLikeBareFrequencyList([['Lead Vocal', '470.100']])).toBe(false));
  it('bare list: empty rows vacuously true', () => expect(looksLikeBareFrequencyList([])).toBe(true));
  it('bare list: only checks the first five rows', () => {
    const rows = [...Array.from({ length: 5 }, () => ['470.100']), ['not-a-number']];
    expect(looksLikeBareFrequencyList(rows)).toBe(true);
  });

  it('read: bare frequency list', () => {
    const cl = readWwbFile('470.100\n471.100\n472.100\n');
    expect(cl.sourceFormat).toBe('wwb-frequency-list');
    expect(cl.channels).toHaveLength(3);
    expect(cl.channels[0]!.name).toBe('CH 1');
    almost(cl.channels[0]!.frequencyMhz, 470.1);
  });

  it('read: comma-separated bare list', () =>
    expect(readWwbFile('470.100,471.100,472.100').channels).toHaveLength(3));

  it('read: structured CSV uses column mapping', () => {
    const cl = readWwbFile('Name,Frequency\nLead Vocal,470.100\nHost Mic,471.100\n');
    expect(cl.sourceFormat).toBe('wwb-csv');
    expect(cl.channels).toHaveLength(2);
    expect(cl.channels[0]!.name).toBe('Lead Vocal');
  });

  it('inventory CSV round-trips via the generic reader', () => {
    const out = writeWwbInventoryCsv(
      list([
        {
          name: 'Lead Vocal',
          frequencyMhz: 470.1,
          group: 'A',
          channel: '1',
          deviceType: 'ULXD2',
          manufacturer: 'Shure',
          notes: 'note',
        },
      ])
    );
    const { header, rows } = readHeaderAndRows(out);
    const back = readRows(rows, sniffMapping(header));
    expect(back.channels).toHaveLength(1);
    const ch = back.channels[0]!;
    expect(ch.name).toBe('Lead Vocal');
    almost(ch.frequencyMhz, 470.1);
    expect(ch.group).toBe('A');
    expect(ch.manufacturer).toBe('Shure');
  });
});

describe('test_wsm_html', () => {
  const cl = readWsmHtmlReport(SAMPLE_WSM_HTML);

  it('detects the report marker', () => expect(looksLikeWsmHtmlReport(SAMPLE_WSM_HTML)).toBe(true));
  it('rejects unrelated HTML', () =>
    expect(looksLikeWsmHtmlReport('<html><body>hello</body></html>')).toBe(false));
  it('header row not treated as data', () => expect(cl.channels).toHaveLength(2));
  it('category carried as zone', () => {
    expect(cl.channels[0]!.zone).toBe('FM Mics');
    expect(cl.channels[1]!.zone).toBe('IEM Systems');
  });
  it('frequency column used, not range', () => almost(cl.channels[0]!.frequencyMhz, 470.5));
  it('fields mapped', () => {
    const ch = cl.channels[0]!;
    expect(ch.name).toBe('EM3732');
    expect(ch.deviceType).toBe('EM 3731/3732');
    expect(ch.manufacturer).toBe('Sennheiser');
    expect(ch.notes).toContain('SK5212/SKM5200');
  });
  it('legacy entity without semicolon resolves (&microV -> µV)', () =>
    expect(cl.channels[0]!.notes).toContain('µV'));
});

describe('test_wsm_xml', () => {
  it('detects the doctype', () => expect(looksLikeWsmXml(SAMPLE_WSM)).toBe(true));
  it('rejects WWB XML', () => expect(looksLikeWsmXml('<show version="1.0"></show>')).toBe(false));
  it('rejects CSV', () => expect(looksLikeWsmXml('name;type;frequency\n')).toBe(false));

  it('reads AllocatedFrequency, not the decoy Frequency', () => {
    const cl = readWsmProject(SAMPLE_WSM);
    expect(cl.channels).toHaveLength(1);
    expect(cl.channels[0]!.name).toBe('EW-DX 1');
    almost(cl.channels[0]!.frequencyMhz, 470.8);
  });

  it('device fields mapped', () => {
    const ch = readWsmProject(SAMPLE_WSM).channels[0]!;
    expect(ch.deviceType).toBe('EW-DX EM2/EM4 (LD off)');
    expect(ch.manufacturer).toBe('Sennheiser');
    expect(ch.notes).toContain('EW-DX SKM');
    expect(ch.notes).toContain('-87 dBm');
  });

  it('empty AllocatedFrequency skipped', () => {
    expect(readWsmProject(SAMPLE_WSM).channels.map((c) => c.name)).not.toContain('EW-DX 2');
  });

  it('no FrequencyManager/Devices returns empty', () => {
    const cl = readWsmProject(SAMPLE_WSM_NO_COORDINATION);
    expect(cl.channels).toHaveLength(0);
    expect(cl.sourceFormat).toBe('wsm-project');
  });
});

describe('test_wwb_report', () => {
  const cl = readWwbReportCsv(SAMPLE_WWB_REPORT);

  it('detects the coordination report header', () =>
    expect(looksLikeWwbReport(SAMPLE_WWB_REPORT)).toBe(true));
  it('detects an RF zone line alone', () => expect(looksLikeWwbReport('RF zone: Default\n')).toBe(true));
  it('rejects unrelated text', () =>
    expect(looksLikeWwbReport('Name,Frequency\nCH1,470.100\n')).toBe(false));

  it('total channel count, inclusion list not double-counted', () =>
    expect(cl.channels).toHaveLength(4));
  it('primary/backup split', () => {
    expect(cl.channels.filter((c) => !c.isBackup)).toHaveLength(3);
    expect(cl.channels.filter((c) => c.isBackup)).toHaveLength(1);
  });
  it('zones assigned correctly', () =>
    expect(new Set(cl.channels.map((c) => c.zone))).toEqual(new Set(['Default', 'Zone 1'])));
  it('inclusion group threaded through', () => {
    const first = cl.channels[0]!;
    expect(first.name).toBe('Shure');
    almost(first.frequencyMhz, 471.95);
    expect(first.inclusionGroup).toBe('Group 1');
    expect(first.isBackup).toBe(false);
  });
  it('"No Inclusion Group" recorded', () =>
    expect(cl.channels[1]!.inclusionGroup).toBe('No Inclusion Group'));
  it('group/channel parsed when assigned', () => {
    expect(cl.channels[1]!.group).toBe('1');
    expect(cl.channels[1]!.channel).toBe('2');
  });
  it('group/channel null when unassigned', () => {
    expect(cl.channels[0]!.group).toBeNull();
    expect(cl.channels[0]!.channel).toBeNull();
  });
  it('backup entry gets a generated name', () =>
    expect(cl.channels.filter((c) => c.isBackup)[0]!.name).toBe('Backup 489.500'));
  it('device type combines type and band', () =>
    expect(cl.channels[0]!.deviceType).toBe('ADPSM/Narrowband (G57)'));
  it('a new zone resets the inclusion group', () => {
    const zone1 = cl.channels.filter((c) => c.zone === 'Zone 1');
    expect(zone1).toHaveLength(1);
    expect(zone1[0]!.inclusionGroup).toBe('No Inclusion Group');
  });
  it('empty report yields no channels', () =>
    expect(readWwbReportCsv('Coordination report\n').channels).toHaveLength(0));
});

describe('test_wwb_xml', () => {
  it('detects the show root', () => expect(looksLikeWwbXml(SAMPLE_SHW)).toBe(true));
  it('detects the cws root', () => expect(looksLikeWwbXml(SAMPLE_CWS)).toBe(true));
  it('rejects CSV', () => expect(looksLikeWwbXml('Name,Frequency\nCH1,470.100\n')).toBe(false));
  it('rejects WSM XML', () => expect(looksLikeWwbXml('<WSM Version="2.0"></WSM>')).toBe(false));

  describe('.shw with inventory', () => {
    const cl = readWwbXml(SAMPLE_SHW);
    it('prefers the device inventory', () => expect(cl.sourceFormat).toBe('wwb-shw'));
    it('zero-frequency channel skipped', () => expect(cl.channels).toHaveLength(1));
    it('deployed channel fields', () => {
      const ch = cl.channels[0]!;
      expect(ch.name).toBe('Lead Vocal');
      almost(ch.frequencyMhz, 470.15);
      expect(ch.zone).toBe('Default');
      expect(ch.group).toBe('1');
      expect(ch.channel).toBe('2');
      expect(ch.deviceType).toBe('G56');
      expect(ch.manufacturer).toBe('Shure');
      expect(ch.notes).toContain('AD4Q-A');
    });
  });

  it('.shw without inventory falls back to the candidate pool', () => {
    const cl = readWwbXml(SAMPLE_SHW_NO_INVENTORY);
    expect(cl.sourceFormat).toBe('wwb-cws');
    expect(cl.channels).toHaveLength(1);
    almost(cl.channels[0]!.frequencyMhz, 471.475);
    expect(cl.channels[0]!.zone).toBe('Zone 1');
  });

  describe('.cws', () => {
    const cl = readWwbXml(SAMPLE_CWS);
    it('source format', () => expect(cl.sourceFormat).toBe('wwb-cws'));
    it('all candidates returned', () => expect(cl.channels).toHaveLength(2));
    it('device type combines series and mode', () =>
      expect(cl.channels[0]!.deviceType).toBe('ADPSM/Narrowband'));
    it('group/channel parsed', () => {
      expect(cl.channels[0]!.group).toBeNull();
      expect(cl.channels[1]!.group).toBe('1');
      expect(cl.channels[1]!.channel).toBe('2');
    });
  });
});

describe('test_detect', () => {
  it('.shw', () => expect(detectFormat(SAMPLE_SHW)).toBe('wwb-xml'));
  it('.cws', () => expect(detectFormat(SAMPLE_CWS)).toBe('wwb-xml'));
  it('WSM project XML', () => expect(detectFormat(SAMPLE_WSM)).toBe('wsm-xml'));
  it('WSM HTML report', () => expect(detectFormat(SAMPLE_WSM_HTML)).toBe('wsm-html'));
  it('WWB coordination report', () => expect(detectFormat(SAMPLE_WWB_REPORT)).toBe('wwb-report'));
  it('WSM CSV', () =>
    expect(
      detectFormat(
        'name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\nFrequency 001;0;510100;0;510100;510100;2;5\n'
      )
    ).toBe('wsm'));
  it('WWB bare frequency list', () =>
    expect(detectFormat('470.100\n471.100\n')).toBe('wwb-frequency-list'));
  it('unrecognised CSV is generic', () =>
    expect(
      detectFormat('Talent,Freq (MHz),Zone,Ch,Device,Brand\nLead Vocal,606.250,A,1,ULXD2,Shure\n')
    ).toBe('generic'));
  it('empty text is vacuously a bare frequency list', () =>
    expect(detectFormat('')).toBe('wwb-frequency-list'));
});

describe('test_sample_data', () => {
  it('sample WSM export detects as wsm', () =>
    expect(detectFormat(sample('sample_wsm_export.csv'))).toBe('wsm'));
  it('sample WSM export parses four channels', () => {
    const cl = readWsmCsv(sample('sample_wsm_export.csv'));
    expect(new Set(cl.channels.map((c) => c.name))).toEqual(
      new Set(['Lead Vocal', 'Host Mic', 'Guitar IEM', 'Handheld 4'])
    );
  });
  it('sample generic export detects as generic', () =>
    expect(detectFormat(sample('sample_generic_export.csv'))).toBe('generic'));
  it('sample WWB frequency list detects as a bare list', () =>
    expect(detectFormat(sample('sample_wwb_frequency_list.txt'))).toBe('wwb-frequency-list'));
  it('sample WWB frequency list parses four channels', () => {
    const cl = readWwbFile(sample('sample_wwb_frequency_list.txt'));
    expect(cl.channels).toHaveLength(4);
    almost(cl.channels[0]!.frequencyMhz, 606.25);
  });
  it('sample WWB report detects as wwb-report', () =>
    expect(detectFormat(sample('sample_wwb_report.csv'))).toBe('wwb-report'));
  it('sample WWB report parses four channels across two zones', () => {
    const cl = readWwbReportCsv(sample('sample_wwb_report.csv'));
    expect(cl.channels).toHaveLength(4);
    expect(new Set(cl.channels.map((c) => c.zone))).toEqual(new Set(['Main Stage', 'Monitor World']));
    expect(cl.channels.every((c) => !c.isBackup)).toBe(true);
  });
});
