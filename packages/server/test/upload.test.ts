import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyUpload, looksLikePdf } from '@rfutils/shared';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('looksLikePdf', () => {
  it('recognises the header at the start of the file', () => {
    expect(looksLikePdf(encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj'))).toBe(true);
  });

  it('tolerates leading junk inside the 1 KiB window readers allow', () => {
    expect(looksLikePdf(encode(`${'\n'.repeat(500)}%PDF-1.4`))).toBe(true);
  });

  it('does not look past that window', () => {
    expect(looksLikePdf(encode(`${' '.repeat(1024)}%PDF-1.4`))).toBe(false);
  });

  it('is happy with a truncated peek shorter than the window', () => {
    expect(looksLikePdf(encode('%PDF'))).toBe(false);
    expect(looksLikePdf(encode('%PDF-'))).toBe(true);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });

  it('is not fooled by "PDF" mentioned in a text file', () => {
    expect(looksLikePdf(encode('Name,Frequency\nPDF mic,606.100\n'))).toBe(false);
  });
});

describe('classifyUpload', () => {
  const pdfBytes = encode('%PDF-1.7\n');
  const csvBytes = encode('Name,Frequency (MHz)\nLead,606.100\n');

  it('routes on content first, whatever the file is called', () => {
    expect(classifyUpload(pdfBytes, 'licence', '')).toBe('pdf');
    expect(classifyUpload(pdfBytes, 'schedule.csv', 'text/csv')).toBe('pdf');
  });

  it('falls back to the MIME type, then the extension', () => {
    expect(classifyUpload(csvBytes, 'unknown', 'application/pdf')).toBe('pdf');
    expect(classifyUpload(csvBytes, 'unknown', 'application/x-pdf')).toBe('pdf');
    expect(classifyUpload(csvBytes, 'Schedule (84).PDF', '')).toBe('pdf');
  });

  it('sends everything else to the text parsers', () => {
    expect(classifyUpload(csvBytes, 'plan.csv', 'text/csv')).toBe('text');
    expect(classifyUpload(csvBytes)).toBe('text');
    expect(classifyUpload(new Uint8Array(0), '', '')).toBe('text');
  });

  it('classifies every real vendor export in the fixtures as text', () => {
    const fixtures = readdirSync(FIXTURES);
    expect(fixtures.length).toBeGreaterThan(5);
    for (const name of fixtures) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
      expect(classifyUpload(bytes.subarray(0, 1024), name, ''), name).toBe('text');
    }
  });
});
