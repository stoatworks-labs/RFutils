/**
 * Which parser an uploaded file belongs to, decided before anything is
 * parsed. The Convert tab takes any file and routes it from here: a PDF goes
 * to the Ofcom PMSE licence parser, everything else to the text-format
 * detector in `formats/detect.ts`.
 *
 * Content is checked first — a PDF announces itself with "%PDF-" near the
 * start of the file — and the name and MIME type only as fallbacks. So a
 * licence dragged out of a mail client with no extension still goes the right
 * way, and a file called `.pdf` that isn't one gets the PDF parser's clear
 * error rather than a column-mapping dialog full of binary.
 *
 * Lives at the root of the package rather than under `formats/` or `pmse/`
 * because the web app imports it statically, and those subpaths pull in
 * xmldom and pdfjs — which the static build loads only on demand.
 */

export type UploadKind = 'pdf' | 'text';

/** "%PDF-", the header every PDF reader looks for. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** How far into the file the header may sit; readers tolerate leading junk up to here. */
const PDF_HEADER_WINDOW = 1024;

/** True when `bytes` (the start of a file, or all of it) carries a PDF header. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length, PDF_HEADER_WINDOW) - PDF_MAGIC.length;
  for (let i = 0; i <= last; i++) {
    if (PDF_MAGIC.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
}

/**
 * Classify an upload from its first bytes, falling back to the MIME type the
 * browser reported and then the file name. `head` may be the whole file.
 */
export function classifyUpload(head: Uint8Array, filename = '', mimeType = ''): UploadKind {
  if (looksLikePdf(head)) return 'pdf';
  if (mimeType === 'application/pdf' || mimeType === 'application/x-pdf') return 'pdf';
  if (filename.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'text';
}
