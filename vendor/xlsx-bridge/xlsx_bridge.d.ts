/* tslint:disable */
/* eslint-disable */

export class ImportedXlsx {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * JSON: `{ lost: {code: count}, kept: {code: count}, cells, formulas, sheets }`.
     */
    report: string;
    /**
     * The workbook in the engine's representation, for `Model.fromBytes()`.
     */
    get workbook(): Uint8Array;
    /**
     * The workbook in the engine's representation, for `Model.fromBytes()`.
     */
    set workbook(value: Uint8Array | number[]);
}

/**
 * Values of one column for sorting. `kinds`: 0 empty, 1 number, 2 text, 3 boolean, 4 error.
 * `numbers` holds numbers (and booleans as 0/1); `texts` holds text, empty otherwise.
 */
export class SortKeys {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    get kinds(): Uint8Array;
    set kinds(value: Uint8Array | number[]);
    get numbers(): Float64Array;
    set numbers(value: Float64Array | number[]);
    texts: string[];
}

export class WorkbookEdit {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Hidden rows of a sheet as (start, end) pairs, ascending.
     */
    hiddenRows(sheet: number): Int32Array;
    constructor(bytes: Uint8Array | number[]);
    /**
     * Moves the rows of the block `top..top+n-1` × `left..=right` so that new row `top + i`
     * holds what was in row `top + order[i]`. Cells (values, formulas, styles), hyperlinks and
     * comments move; row heights and hidden flags stay with the row numbers. Refuses blocks
     * with merged cells or array formulas, which IronCalc ties to fixed positions.
     */
    reorderRows(sheet: number, top: number, left: number, right: number, order: Uint32Array | number[]): void;
    /**
     * Sets which rows in `from..=to` are hidden: exactly those inside the `ranges` pairs
     * (start, end, start, end, ...). Rows outside `from..=to` are not touched.
     */
    setHiddenRows(sheet: number, from: number, to: number, ranges: Int32Array | number[]): void;
    /**
     * The stored (evaluated) value of each cell of `column` in rows `top..=bottom`.
     */
    sortKeys(sheet: number, top: number, bottom: number, column: number): SortKeys;
    toBytes(): Uint8Array;
}

/**
 * Reads an .xlsx file with IronCalc's importer.
 */
export function importXlsx(xlsx: Uint8Array | number[], name: string, locale: string, timezone: string): ImportedXlsx;

/**
 * Writes the engine's workbook bytes as .xlsx with IronCalc's exporter.
 */
export function workbookToXlsx(bytes: Uint8Array | number[], language: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_importedxlsx_report: (a: number) => [number, number];
    readonly __wbg_get_importedxlsx_workbook: (a: number) => [number, number];
    readonly __wbg_get_sortkeys_kinds: (a: number) => [number, number];
    readonly __wbg_get_sortkeys_numbers: (a: number) => [number, number];
    readonly __wbg_get_sortkeys_texts: (a: number) => [number, number];
    readonly __wbg_importedxlsx_free: (a: number, b: number) => void;
    readonly __wbg_set_importedxlsx_report: (a: number, b: number, c: number) => void;
    readonly __wbg_set_importedxlsx_workbook: (a: number, b: number, c: number) => void;
    readonly __wbg_set_sortkeys_kinds: (a: number, b: number, c: number) => void;
    readonly __wbg_set_sortkeys_numbers: (a: number, b: number, c: number) => void;
    readonly __wbg_set_sortkeys_texts: (a: number, b: number, c: number) => void;
    readonly __wbg_sortkeys_free: (a: number, b: number) => void;
    readonly __wbg_workbookedit_free: (a: number, b: number) => void;
    readonly importXlsx: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly workbookToXlsx: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly workbookedit_hiddenRows: (a: number, b: number) => [number, number, number, number];
    readonly workbookedit_new: (a: number, b: number) => [number, number, number];
    readonly workbookedit_reorderRows: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly workbookedit_setHiddenRows: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly workbookedit_sortKeys: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly workbookedit_toBytes: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
