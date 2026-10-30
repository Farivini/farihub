/**
 * Delimited text files (CSV, TSV, TXT): decoding, separator detection, parsing (RFC 4180
 * quoting, embedded line breaks) and how each value becomes engine input.
 *
 * Values are interpreted explicitly rather than handed to the engine as typed text, because
 * the file's conventions (decimal point, codes with leading zeros) are not the user's typing
 * conventions. The engine runs in a comma-decimal locale and reads dd/mm/yyyy dates.
 */

export type Separator = ';' | ',' | '\t' | '|';
export type Encoding = 'utf-8' | 'windows-1252';
export type DecimalMark = ',' | '.';
export type ColumnType = 'auto' | 'text';

export interface DelimitedOptions {
  encoding: Encoding;
  separator: Separator;
  decimal: DecimalMark;
  /** The first row holds column names: imported as text and left out of type detection. */
  header: boolean;
  /** Per column; missing entries are 'auto'. */
  columns: ColumnType[];
}

export const SEPARATORS: Array<{ value: Separator; label: string }> = [
  { value: ';', label: 'Ponto e vírgula (;)' },
  { value: ',', label: 'Vírgula (,)' },
  { value: '\t', label: 'Tabulação' },
  { value: '|', label: 'Barra vertical (|)' },
];

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (Excel's "CSV" in Brazil). */
export function detectEncoding(bytes: Uint8Array): Encoding {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

export function decodeText(bytes: Uint8Array, encoding: Encoding): string {
  // ignoreBOM false (default) drops a UTF-8 byte order mark.
  return new TextDecoder(encoding).decode(bytes);
}

/**
 * The candidate that splits the first lines into the same, largest number of fields.
 * Quoted text is skipped, so separators inside quotes do not count.
 */
export function detectSeparator(text: string): Separator {
  const sample = text.slice(0, 64 * 1024);
  // A cut sample ends in a partial line, which would not match the others.
  const lines = (sample.length < text.length ? sample.slice(0, sample.lastIndexOf('\n')) : sample).split(/\r?\n/).slice(0, 20);
  let best: Separator = ';';
  let bestScore = -1;
  for (const { value } of SEPARATORS) {
    const counts = lines.filter(line => line !== '').map(line => countOutsideQuotes(line, value));
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.filter(c => c === counts[0]).length / counts.length;
    const score = consistent * 1000 + counts[0];
    if (score > bestScore) { bestScore = score; best = value; }
  }
  return best;
}

function countOutsideQuotes(line: string, separator: string): number {
  let quoted = false;
  let count = 0;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === separator && !quoted) count++;
  }
  return count;
}

/** Decimal mark used by the numbers in a sample: comma unless only point-decimal numbers appear. */
export function detectDecimal(rows: string[][], separator: Separator): DecimalMark {
  let comma = 0;
  let point = 0;
  for (const row of rows) {
    for (const value of row) {
      const v = value.trim();
      if (/^[+-]?\d+,\d+$/.test(v) || /^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(v)) comma++;
      if (/^[+-]?\d+\.\d+$/.test(v) && !/^[+-]?\d{1,3}\.\d{3}$/.test(v)) point++;
      if (/^[+-]?\d{1,3}(,\d{3})+\.\d+$/.test(v)) point++;
    }
  }
  if (point > comma) return '.';
  if (comma > 0) return ',';
  return separator === ',' ? '.' : ',';
}

/**
 * Parses delimited text into rows. Quotes follow RFC 4180 (a field that starts with a quote
 * runs to the matching quote; doubled quotes are one quote; line breaks inside are kept).
 * A final line break does not make an extra row. Stops after `limit` rows.
 */
export function* parseDelimited(text: string, separator: Separator, limit = Infinity): Generator<string[]> {
  let i = 0;
  const n = text.length;
  let produced = 0;
  while (i < n && produced < limit) {
    const row: string[] = [];
    for (;;) {
      let field = '';
      if (text[i] === '"') {
        i++;
        for (;;) {
          const quote = text.indexOf('"', i);
          if (quote === -1) { field += text.slice(i); i = n; break; }
          field += text.slice(i, quote);
          i = quote + 1;
          if (text[i] === '"') { field += '"'; i++; continue; }
          break;
        }
        // Text after the closing quote up to the separator is kept as is.
        while (i < n && text[i] !== separator && text[i] !== '\n' && text[i] !== '\r') field += text[i++];
      } else {
        while (i < n && text[i] !== separator && text[i] !== '\n' && text[i] !== '\r') field += text[i++];
      }
      row.push(field);
      if (i < n && text[i] === separator) { i++; continue; }
      if (text[i] === '\r') i++;
      if (text[i] === '\n') i++;
      break;
    }
    produced++;
    yield row;
  }
}

export type ValueKind = 'empty' | 'number' | 'date' | 'text';
export interface Interpreted { kind: ValueKind; input: string | null }

const MAX_EXACT_DIGITS = 15;
/** CPF has 11 digits, CNPJ 14; phone numbers and barcodes are as long. */
const CODE_DIGITS = 11;

/**
 * Columns whose values look like codes: digits with leading zeros, or a long run of digits
 * with no separators (CPF, CNPJ, phones, barcodes), which would lose zeros or precision as numbers.
 */
export function suggestColumnTypes(rows: string[][]): ColumnType[] {
  const width = Math.max(0, ...rows.map(r => r.length));
  return Array.from({ length: width }, (_, c) => rows.some(row => isCode((row[c] ?? '').trim())) ? 'text' : 'auto');
}

function isCode(v: string): boolean {
  return /^0\d+$/.test(v) || (/^\d+$/.test(v) && v.length >= CODE_DIGITS);
}

/**
 * How one value enters the engine. Numbers are rewritten with the engine's comma decimal and no
 * grouping; dd/mm/yyyy and yyyy-mm-dd dates are passed as dates; everything else is text. Text
 * that the engine would read as something else (a formula, a number, TRUE) gets the
 * quote prefix, so a CSV can never inject a formula.
 */
export function interpret(raw: string, type: ColumnType, decimal: DecimalMark): Interpreted {
  if (raw === '') return { kind: 'empty', input: null };
  if (type === 'auto') {
    const v = raw.trim();
    const number = toNumber(v, decimal);
    if (number !== null && !isCode(v.replace(/^[+-]/, ''))) return { kind: 'number', input: number };
    const date = toDate(v);
    if (date) return { kind: 'date', input: date };
  }
  return { kind: 'text', input: needsQuote(raw) ? `'${raw}` : raw };
}

function toNumber(v: string, decimal: DecimalMark): string | null {
  const group = decimal === ',' ? '\\.' : ',';
  const dec = decimal === ',' ? ',' : '\\.';
  const pattern = new RegExp(`^([+-]?)(\\d{1,3}(?:${group}\\d{3})+|\\d+)(?:${dec}(\\d+))?(%?)$`);
  const match = pattern.exec(v);
  if (!match) return null;
  const [, sign, whole, fraction, percent] = match;
  const digits = whole.replace(/[.,]/g, '');
  if ((digits + (fraction ?? '')).replace(/^0+/, '').length > MAX_EXACT_DIGITS) return null;
  return `${sign === '-' ? '-' : ''}${digits}${fraction ? `,${fraction}` : ''}${percent}`;
}

function toDate(v: string): string | null {
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (match) {
    const [, d, m, y] = match.map(Number);
    return validDate(y, m, d) ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` : null;
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (match) {
    const [, y, m, d] = match.map(Number);
    return validDate(y, m, d) ? `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}` : null;
  }
  return null;
}

function validDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function needsQuote(v: string): boolean {
  const t = v.trim();
  return /^[=+\-@']/.test(t)
    || /^(true|false|verdadeiro|falso)$/i.test(t)
    || /^[\d\s.,%/:+\-eE]+$/.test(t)
    || /^#[A-Z/0!?.]+$/i.test(t);
}

/** Field quoting for CSV/TSV output: separator, quote or line break inside, or edge spaces. */
export function quoteField(value: string, separator: Separator): string {
  return value.includes(separator) || /["\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

export function serializeDelimited(rows: string[][], separator: Separator): string {
  return rows.map(row => row.map(v => quoteField(v, separator)).join(separator)).join('\r\n') + '\r\n';
}
