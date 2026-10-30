import { useMemo, useState } from 'react';
import { columnName } from '../../core/address.ts';
import { SEPARATORS, decodeText, detectDecimal, detectEncoding, detectSeparator, interpret, parseDelimited, suggestColumnTypes } from '../../core/delimited.ts';
import type { ColumnType, DecimalMark, DelimitedOptions, Encoding, Separator } from '../../core/delimited.ts';
import { Dialog } from '../shell/Dialog.tsx';

const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_ROWS = 12;

/**
 * Preview of a CSV, TSV or TXT file before it becomes a workbook: encoding, separator,
 * decimal mark, header row and the type of each column, with every value shown as it will
 * be read. Nothing is imported until the person confirms.
 */
export function ImportDialog({ fileName, bytes, onCancel, onImport }: {
  fileName: string; bytes: Uint8Array; onCancel(): void; onImport(options: DelimitedOptions): void;
}) {
  const head = bytes.subarray(0, PREVIEW_BYTES);
  const [encoding, setEncoding] = useState<Encoding>(() => detectEncoding(head));
  const sample = useMemo(() => {
    // A cut multi-byte character at the end of the sample is not an encoding error.
    const text = decodeText(head, encoding);
    return head.length < bytes.length ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
  }, [encoding]); // eslint-disable-line react-hooks/exhaustive-deps
  const [separator, setSeparator] = useState<Separator>(() => fileName.toLowerCase().endsWith('.tsv') ? '\t' : detectSeparator(sample));
  const rows = useMemo(() => [...parseDelimited(sample, separator, PREVIEW_ROWS * 4)], [sample, separator]);
  const [header, setHeader] = useState(true);
  const [decimal, setDecimal] = useState<DecimalMark>(() => detectDecimal(rows, separator));
  const suggested = useMemo(() => suggestColumnTypes(rows.slice(1)), [rows]);
  const [overrides, setOverrides] = useState<Record<number, ColumnType>>({});
  const width = Math.max(1, ...rows.map(r => r.length));
  const columns = Array.from({ length: width }, (_, c) => overrides[c] ?? suggested[c] ?? 'auto');
  const body = (header ? rows.slice(1) : rows).slice(0, PREVIEW_ROWS);
  const codes = columns.flatMap((type, c) => type === 'text' && suggested[c] === 'text' && overrides[c] === undefined ? [label(c)] : []);
  function label(c: number) { return header && rows[0]?.[c] ? `${columnName(c + 1)} (${rows[0][c]})` : columnName(c + 1); }

  const changeSeparator = (value: Separator) => { setSeparator(value); setOverrides({}); };
  const options: DelimitedOptions = { encoding, separator, decimal, header, columns };

  return (
    <Dialog title={`Importar ${fileName}`} testId="import-dialog" wide onClose={onCancel} actions={<>
      <button type="button" onClick={onCancel}>Cancelar</button>
      <button type="button" className="primary" data-testid="import-confirm" onClick={() => onImport(options)}>Importar</button>
    </>}>
      <div className="import-options">
        <label>Codificação
          <select value={encoding} data-testid="import-encoding" onChange={e => { setEncoding(e.target.value as Encoding); setOverrides({}); }}>
            <option value="utf-8">UTF-8</option>
            <option value="windows-1252">Windows-1252 (Excel no Windows)</option>
          </select>
        </label>
        <label>Separador
          <select value={separator} data-testid="import-separator" onChange={e => changeSeparator(e.target.value as Separator)}>
            {SEPARATORS.map(s => <option key={s.label} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label>Decimal
          <select value={decimal} data-testid="import-decimal" onChange={e => setDecimal(e.target.value as DecimalMark)}>
            <option value=",">Vírgula (1.234,56)</option>
            <option value=".">Ponto (1,234.56)</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={header} data-testid="import-header" onChange={e => setHeader(e.target.checked)} />Primeira linha é cabeçalho</label>
      </div>
      <div className="import-preview" role="region" aria-label="Prévia">
        <table>
          <thead>
            <tr>
              {columns.map((type, c) => (
                <th key={c}>
                  <span title={label(c)}>{header ? rows[0]?.[c] || columnName(c + 1) : columnName(c + 1)}</span>
                  <select aria-label={`Tipo da coluna ${label(c)}`} value={type} data-testid={`import-type-${c}`}
                    onChange={e => setOverrides(o => ({ ...o, [c]: e.target.value as ColumnType }))}>
                    <option value="auto">Automático</option>
                    <option value="text">Texto</option>
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {columns.map((type, c) => {
                  const value = interpret(row[c] ?? '', type, decimal);
                  const shown = value.input === null ? '' : value.kind === 'text' && value.input.startsWith("'") ? value.input.slice(1) : value.input;
                  return <td key={c} className={value.kind} title={value.kind === 'number' ? 'Número' : value.kind === 'date' ? 'Data' : value.kind === 'text' ? 'Texto' : ''}>{shown}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="import-note" data-testid="import-note">
        Números alinhados à direita, datas em dd/mm/aaaa, texto à esquerda: é assim que cada valor entra na planilha. Nenhum valor vira fórmula.
        {codes.length > 0 && <> Tratadas como texto para manter zeros à esquerda ou dígitos longos: {codes.join(', ')}.</>}
      </p>
    </Dialog>
  );
}
