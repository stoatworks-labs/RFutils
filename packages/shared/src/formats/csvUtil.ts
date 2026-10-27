/**
 * Minimal RFC-4180-ish CSV reader/writer with a configurable delimiter,
 * standing in for Python's `csv` module. Handles quoted fields, escaped
 * quotes (""), and newlines inside quotes.
 */

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      // swallow CRLF as one line break
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // trailing field/row (unless file ended exactly on a newline with nothing after)
  if (field !== '' || row.length > 0) {
    pushRow();
  }
  return rows;
}

/** Parse and drop rows that are entirely empty/whitespace. */
export function parseCsvNonEmpty(text: string, delimiter = ','): string[][] {
  return parseCsv(text, delimiter).filter((r) => r.some((c) => c.trim() !== ''));
}

function needsQuoting(value: string, delimiter: string): boolean {
  return (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  );
}

function encodeField(value: string, delimiter: string): string {
  if (needsQuoting(value, delimiter)) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/** Matches Python csv.writer default line terminator (\r\n) unless a format needs another. */
export function writeCsv(rows: (string | number)[][], delimiter = ',', lineEnd = '\r\n'): string {
  return (
    rows
      .map((row) => row.map((c) => encodeField(String(c), delimiter)).join(delimiter))
      .join(lineEnd) + lineEnd
  );
}
