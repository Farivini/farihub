/**
 * Tab separated text as written by Excel and spreadsheet apps on the clipboard.
 * Fields containing tab, newline or quote are quoted; quotes are doubled.
 */

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  // Clipboard text usually ends with one line break that is not an extra empty row.
  const source = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (source === '') return [['']];
  while (i <= source.length) {
    if (field === '' && source[i] === '"') {
      // Quoted field: only when it starts the field, as Excel does.
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') { value += '"'; j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        value += source[j++];
      }
      if (closed && (j === source.length || source[j] === '\t' || source[j] === '\n')) {
        field = value;
        i = j;
      } else {
        // Not a well formed quoted field: keep the raw text.
        field += source[i++];
        continue;
      }
    }
    const ch = source[i];
    if (i === source.length || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (ch === '\t') {
      row.push(field);
      field = '';
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  const width = Math.max(...rows.map(r => r.length));
  return rows.map(r => r.length < width ? [...r, ...Array(width - r.length).fill('')] : r);
}

export function quoteTsvField(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeTsv(rows: string[][]): string {
  return rows.map(row => row.map(quoteTsvField).join('\t')).join('\n');
}
