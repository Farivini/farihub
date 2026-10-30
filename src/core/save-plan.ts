import { lostFeatures } from './xlsx-report.ts';
import type { XlsxReport } from './xlsx-report.ts';

/** Workbook formats Save writes. CSV and TSV are exports of one sheet, not saves. */
export type SaveFormat = 'xlsx' | 'farcel';

/**
 * The file a workbook was imported from, with what that import did not keep. Saved in the
 * .farcel header, so the warnings survive closing and reopening.
 */
export interface Origin { name: string; format: 'XLSX' | 'CSV' | 'TSV' | 'TXT'; report: XlsxReport | null }

/**
 * Something the file will not have. `inWorkbook`: part of the workbook as it is now, so a file
 * without it is not a complete save (the workbook stays marked unsaved). Features the original
 * file had and were never imported are not in the workbook: they are reported, not counted.
 */
export interface Loss { text: string; inWorkbook: boolean }

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

export function saveLosses(format: SaveFormat, state: { pivots: number; origin: Origin | null }): Loss[] {
  if (format === 'farcel') return [];
  const losses: Loss[] = [];
  if (state.pivots) {
    losses.push({ text: `${plural(state.pivots, 'tabela dinâmica', 'tabelas dinâmicas')} do Planilhas e seus gráficos: o XLSX não guarda; só o .farcel.`, inWorkbook: true });
  }
  const lost = state.origin?.report ? lostFeatures(state.origin.report) : [];
  if (lost.length) {
    losses.push({ text: `Do arquivo original ${state.origin!.name}, o que não foi importado também não volta: ${lost.join(', ')}.`, inWorkbook: false });
  }
  return losses;
}

export function delimitedLosses(format: 'csv' | 'tsv', state: { sheets: string[]; sheet: number; pivots: number }): Loss[] {
  const losses: Loss[] = [];
  if (state.sheets.length > 1) {
    losses.push({ text: `Só a planilha ${state.sheets[state.sheet]}: ${format.toUpperCase()} guarda uma planilha por arquivo (as outras ${state.sheets.length - 1} ficam de fora).`, inWorkbook: true });
  }
  losses.push({ text: 'Valores como aparecem na tela: fórmulas viram seus resultados e a formatação (negrito, alinhamento, formatos de número) não vai.', inWorkbook: true });
  if (state.pivots) losses.push({ text: `${plural(state.pivots, 'tabela dinâmica', 'tabelas dinâmicas')} do Planilhas e seus gráficos.`, inWorkbook: true });
  return losses;
}

/** A save is complete when the file holds the whole workbook as it is. */
export const isComplete = (losses: Loss[]) => !losses.some(loss => loss.inWorkbook);

/** Identifies a set of losses the person already accepted for this workbook. */
export const lossKey = (losses: Loss[]) => losses.map(loss => loss.text).join('\n');

/** Origin read back from a file header; anything malformed is dropped rather than trusted. */
export function parseOrigin(value: unknown): Origin | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<Origin>;
  if (typeof v.name !== 'string' || !['XLSX', 'CSV', 'TSV', 'TXT'].includes(v.format as string)) return null;
  const r = v.report as Partial<XlsxReport> | null | undefined;
  const counts = (x: unknown) => x && typeof x === 'object' && Object.values(x).every(n => typeof n === 'number') ? x as Record<string, number> : {};
  const report = r && typeof r === 'object'
    ? { lost: counts(r.lost), kept: counts(r.kept), cells: Number(r.cells) || 0, formulas: Number(r.formulas) || 0, sheets: Number(r.sheets) || 0 }
    : null;
  return { name: v.name, format: v.format as Origin['format'], report };
}
