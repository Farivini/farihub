import type { CellRef, Rect } from '../core/address.ts';
import type { PivotConfig, PivotResult } from '../core/pivot.ts';
import type { FarcelHeader } from '../core/file-format.ts';
import type { AssistantContext } from '../core/assistant-context.ts';
import type { DelimitedOptions, Separator } from '../core/delimited.ts';
import type { CellFormat, FormatChange, GenerationReport, Viewport } from './workbook-engine.ts';

export interface WorkbookInfo { name: string; sheets: string[]; revision: number; canUndo: boolean; canRedo: boolean }
export interface MutationResult extends WorkbookInfo { sheet: number; rect: Rect | null; ms: number }
export interface PivotResponse extends PivotResult { extractMs: number; aggregateMs: number; revision: number }
export interface EngineStats { wasmMemoryBytes: number | null; revision: number; extraction: Array<{ column: string; rows: number; ms: number }> }

/** Request name -> [payload, response]. */
export interface EngineApi {
  init: [void, WorkbookInfo & { engine: string; locale: string }];
  newWorkbook: [void, WorkbookInfo];
  viewport: [{ sheet: number; top: number; left: number; rows: number; columns: number }, Viewport];
  input: [{ sheet: number; row: number; column: number }, string];
  setInput: [{ sheet: number; row: number; column: number; text: string }, MutationResult];
  clear: [{ sheet: number; rect: Rect }, MutationResult];
  paste: [{ sheet: number; origin: CellRef; text: string }, MutationResult];
  copy: [{ sheet: number; rect: Rect }, string];
  cellFormat: [{ sheet: number; row: number; column: number }, CellFormat];
  format: [{ sheet: number; rect: Rect; change: FormatChange }, MutationResult];
  undo: [void, MutationResult | null];
  redo: [void, MutationResult | null];
  edge: [{ sheet: number; from: CellRef; direction: 'up' | 'down' | 'left' | 'right' }, CellRef];
  addSheet: [void, MutationResult];
  pivotFields: [{ sheet: number }, { fields: string[]; rows: number }];
  pivotLabels: [{ sheet: number; field: string }, string[]];
  pivot: [{ sheet: number; config: PivotConfig }, PivotResponse];
  save: [{ app: Record<string, unknown> }, { bytes: Uint8Array; ms: number }];
  open: [{ bytes: Uint8Array }, WorkbookInfo & { header: FarcelHeader; ms: number; evaluateMs: number }];
  /** Replaces the workbook with `Model.toBytes()` data (an .xlsx converted by the XLSX worker). */
  loadModel: [{ bytes: Uint8Array }, WorkbookInfo & { ms: number; evaluateMs: number }];
  /** The workbook as `Model.toBytes()` data, for the XLSX worker. */
  modelBytes: [void, { bytes: Uint8Array; ms: number }];
  importDelimited: [{ bytes: Uint8Array; name: string; options: DelimitedOptions }, WorkbookInfo & { rows: number; columns: number; ms: number }];
  exportDelimited: [{ sheet: number; separator: Separator }, { bytes: Uint8Array; rows: number; columns: number; ms: number }];
  generate: [{ rows: number; seed: number }, WorkbookInfo & { report: GenerationReport }];
  stats: [void, EngineStats];
  assistantContext: [{ sheet: number; selection: Rect; pivotRows: string[][] | null }, AssistantContext];
}

export type RequestType = keyof EngineApi;
export interface Request<T extends RequestType = RequestType> { id: number; type: T; payload: EngineApi[T][0] }
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type EngineEvent =
  | { event: 'progress'; task: 'generate' | 'pivot' | 'open' | 'import'; done: number; total: number; label: string }
  | { event: 'changed'; revision: number };
