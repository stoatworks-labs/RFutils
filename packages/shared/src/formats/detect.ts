/**
 * Guess which format a loaded file is in. Ported from wsm-wwb-bridge/detect.py.
 * Returns one of the DetectedFormat values (text-based formats only; a PDF
 * is recognised from its bytes by `classifyUpload` in `../upload.ts` before
 * the file is ever decoded as text, and goes to the PMSE parser instead).
 */

import type { DetectedFormat } from '../index.js';
import { readHeaderAndRows } from './csvGeneric.js';
import { looksLikeWsmHtmlReport } from './wsmHtml.js';
import { looksLikeWsmXml } from './wsmXml.js';
import { looksLikeBareFrequencyList } from './wwb.js';
import { looksLikeWwbReport } from './wwbReport.js';
import { looksLikeWwbXml } from './wwbXml.js';

export function detectFormat(text: string): DetectedFormat {
  if (looksLikeWwbXml(text)) return 'wwb-xml';
  if (looksLikeWsmXml(text)) return 'wsm-xml';
  if (looksLikeWsmHtmlReport(text)) return 'wsm-html';

  const { delimiter, header, rows } = readHeaderAndRows(text);
  const allRows = header.length ? [header, ...rows] : rows;

  if (header.length) {
    const firstCell = header[0]!.trim().toLowerCase();
    if (delimiter === ';' && firstCell === 'name' && header.length >= 6) {
      return 'wsm';
    }
  }

  if (looksLikeWwbReport(text)) return 'wwb-report';
  if (looksLikeBareFrequencyList(allRows)) return 'wwb-frequency-list';

  return 'generic';
}
