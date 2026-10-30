/// <reference lib="webworker" />
import init, * as ironcalc from '@ironcalc/wasm';
import wasmUrl from '@ironcalc/wasm/wasm_bg.wasm?url';
import bridgeWasmUrl from '../../vendor/xlsx-bridge/xlsx_bridge_bg.wasm?url';
import { ENGINE_LOCALE, WorkbookEngine, IRONCALC_VERSION } from './workbook-engine.ts';
import type { Change } from './workbook-engine.ts';
import type { EngineApi, EngineEvent, MutationResult, Request, RequestType, Response, WorkbookInfo } from './protocol.ts';
import { SLOW_OPERATION_SECONDS, isStructural, parseFilters } from '../core/table-ops.ts';
import { boundContext } from '../core/assistant-context.ts';
import { cellName, rectName } from '../core/address.ts';

declare const self: DedicatedWorkerGlobalScope;

let memory: WebAssembly.Memory | null = null;
const memoryBytes = () => memory?.buffer.byteLength ?? null;
let engine: WorkbookEngine;
/** WASM instantiation starts with the worker; every request waits for it. */
const ready = init({ module_or_path: wasmUrl }).then(output => {
  memory = output.memory;
  engine = WorkbookEngine.create(ironcalc, 'Pasta1', memoryBytes);
});
/** Long tasks that replace the model; edits are refused meanwhile. */
let busy: string | null = null;

/**
 * The engine-data editor (sort, hidden rows), compiled with the same IronCalc. Loaded on the
 * first table operation or file opened, not with the worker.
 */
let bridge: Promise<void> | null = null;
function ensureBridge(): Promise<void> {
  bridge ??= import('../../vendor/xlsx-bridge/xlsx_bridge.js').then(async module => {
    await module.default({ module_or_path: bridgeWasmUrl });
    WorkbookEngine.bridge = module;
  }).catch(error => {
    bridge = null;
    throw error;
  });
  return bridge;
}

/** Makes `next` the workbook and releases the previous one (its models and undo copies). */
function replace(next: WorkbookEngine) {
  if (next === engine) return;
  const previous = engine;
  engine = next;
  previous?.dispose();
}

const emit = (event: EngineEvent) => self.postMessage(event);

function info(): WorkbookInfo {
  return {
    name: engine.name, sheets: engine.sheets(), revision: engine.revision, canUndo: engine.canUndo(), canRedo: engine.canRedo(),
    layoutVersion: engine.layoutVersion, filtered: engine.filteredSheets(), historyTrimmed: engine.historyTrimmed,
  };
}

function mutation(run: () => Change | null): MutationResult | null {
  if (busy) throw new Error(`Aguarde: ${busy}.`);
  const started = performance.now();
  const change = run();
  if (!change) return null;
  emit({ event: 'changed', revision: engine.revision });
  return { ...info(), sheet: change.sheet, rect: change.rect, ms: performance.now() - started };
}

type Handlers = { [K in RequestType]: (payload: EngineApi[K][0]) => EngineApi[K][1] | Promise<EngineApi[K][1]> };

const handlers: Handlers = {
  init: () => {
    return { ...info(), engine: `IronCalc ${IRONCALC_VERSION} (WASM)`, locale: ENGINE_LOCALE };
  },
  newWorkbook: () => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    replace(WorkbookEngine.create(ironcalc, 'Pasta1', memoryBytes));
    emit({ event: 'changed', revision: engine.revision });
    return info();
  },
  viewport: p => engine.viewport(p.sheet, p.top, p.left, p.rows, p.columns),
  input: p => engine.input(p.sheet, p.row, p.column),
  setInput: p => mutation(() => engine.setInput(p.sheet, p.row, p.column, p.text))!,
  clear: p => mutation(() => engine.clear(p.sheet, p.rect))!,
  paste: p => mutation(() => engine.paste(p.sheet, p.origin, p.text))!,
  copy: p => engine.copy(p.sheet, p.rect),
  cellFormat: p => engine.cellFormat(p.sheet, p.row, p.column),
  format: p => mutation(() => engine.format(p.sheet, p.rect, p.change))!,
  undo: () => mutation(() => engine.undo()),
  redo: () => mutation(() => engine.redo()),
  edge: p => engine.edge(p.sheet, p.from, p.direction),
  addSheet: () => mutation(() => {
    const sheet = engine.addSheet();
    return { sheet, rect: { top: 1, left: 1, bottom: 1, right: 1 } };
  })!,
  pivotFields: p => {
    if (engine.pivotSource.sheet !== p.sheet) engine.pivotSource.reset(p.sheet);
    return { fields: engine.pivotSource.fields().map(f => f.name), rows: engine.pivotSource.rowCount };
  },
  pivotLabels: async p => {
    if (engine.pivotSource.sheet !== p.sheet) engine.pivotSource.reset(p.sheet);
    return engine.pivotSource.labels(p.field);
  },
  pivot: async p => {
    if (engine.pivotSource.sheet !== p.sheet) engine.pivotSource.reset(p.sheet);
    const result = await engine.pivot(p.config, (done, total, field) => emit({ event: 'progress', task: 'pivot', done, total, label: field }));
    return { ...result, revision: engine.revision };
  },
  save: p => {
    const started = performance.now();
    const bytes = engine.toFile(p.app);
    return { bytes, ms: performance.now() - started };
  },
  open: async p => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    busy = 'abrindo arquivo';
    try {
      const started = performance.now();
      await ensureBridge();
      const opened = WorkbookEngine.fromFile(ironcalc, p.bytes, memoryBytes);
      try {
        opened.engine.loadLayout(parseFilters(opened.header.app?.filters));
      } catch (error) {
        opened.engine.dispose();
        throw error;
      }
      replace(opened.engine);
      emit({ event: 'changed', revision: engine.revision });
      return { ...info(), header: opened.header, ms: performance.now() - started, evaluateMs: opened.evaluateMs };
    } finally {
      busy = null;
    }
  },
  loadModel: async p => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    busy = 'abrindo arquivo';
    try {
      const started = performance.now();
      await ensureBridge();
      const loaded = WorkbookEngine.fromModelBytes(ironcalc, p.bytes, memoryBytes);
      try {
        loaded.engine.loadLayout();
      } catch (error) {
        loaded.engine.dispose();
        throw error;
      }
      replace(loaded.engine);
      emit({ event: 'changed', revision: engine.revision });
      return { ...info(), ms: performance.now() - started, evaluateMs: loaded.evaluateMs };
    } finally {
      busy = null;
    }
  },
  modelBytes: () => {
    const started = performance.now();
    const bytes = engine.modelBytes();
    return { bytes, ms: performance.now() - started };
  },
  importDelimited: async p => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    busy = 'importando arquivo';
    try {
      const started = performance.now();
      const imported = await WorkbookEngine.fromDelimited(ironcalc, p.name, p.bytes, p.options, {
        memoryBytes,
        onProgress: (done, total) => emit({ event: 'progress', task: 'import', done, total, label: 'linhas' }),
      });
      replace(imported.engine);
      emit({ event: 'changed', revision: engine.revision });
      return { ...info(), rows: imported.rows, columns: imported.columns, ms: performance.now() - started };
    } finally {
      busy = null;
    }
  },
  exportDelimited: p => {
    const started = performance.now();
    const { text, rows, columns, protectedCells } = engine.toDelimited(p.sheet, p.separator, p.mode);
    // UTF-8 with a byte order mark, so Excel detects the encoding of accented text.
    const bytes = new TextEncoder().encode(`\ufeff${text}`);
    return { bytes, rows, columns, protectedCells, ms: performance.now() - started };
  },
  generate: async p => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    if (!Number.isSafeInteger(p.rows) || p.rows < 1 || p.rows > 1_048_575) throw new RangeError('Quantidade de linhas inválida');
    busy = 'gerando base sintética';
    const before = engine;
    try {
      const { engine: generated, report } = await WorkbookEngine.generateSynthetic(ironcalc, p.rows, p.seed, {
        memoryBytes,
        onProgress: (done, total, partial) => {
          engine = partial; // the grid can show the rows already written
          emit({ event: 'progress', task: 'generate', done, total, label: 'linhas' });
          emit({ event: 'changed', revision: partial.revision + done });
        },
      });
      engine = generated;
      if (before !== generated) before.dispose();
      emit({ event: 'changed', revision: engine.revision });
      return { ...info(), report };
    } finally {
      busy = null;
    }
  },
  tableOp: async p => {
    if (busy) throw new Error(`Aguarde: ${busy}.`);
    if (isStructural(p.op) && !p.confirmed) {
      const cost = engine.estimate(p.op);
      if (cost.seconds > SLOW_OPERATION_SECONDS) return { done: false, cost };
    }
    if (!isStructural(p.op)) await ensureBridge();
    return { done: true, ...mutation(() => engine.apply(p.op))! };
  },
  tableQuery: q => q.kind === 'region'
    ? { kind: 'region', rect: engine.region(q.sheet, q.cell) }
    : { kind: 'filterValues', ...engine.filterValues(q.sheet, q.column, q.search, q.limit) },
  rowLayout: p => {
    const layout = engine.rowLayout(p.sheet);
    return { sheet: p.sheet, hidden: layout.hidden, filter: layout.filter, layoutVersion: engine.layoutVersion };
  },
  stats: () => ({ wasmMemoryBytes: memoryBytes(), revision: engine.revision, extraction: [...engine.pivotSource.stats] }),
  assistantContext: p => {
    const source = engine.pivotSource;
    if (source.sheet !== p.sheet) source.reset(p.sheet);
    const fields = source.fields();
    const sampleRows = Math.min(20, source.rowCount);
    const sample = sampleRows > 0 && fields.length ? engine.viewport(p.sheet, 2, 1, sampleRows, fields.length) : null;
    return boundContext({
      workbook: engine.name,
      sheet: engine.sheets()[p.sheet],
      selection: p.selection.top === p.selection.bottom && p.selection.left === p.selection.right
        ? cellName({ row: p.selection.top, column: p.selection.left }) : rectName(p.selection),
      dataRows: source.rowCount,
      headers: fields.map(f => f.name),
      sample: sample ? Array.from({ length: sample.rows }, (_, r) => sample.values.slice(r * sample.columns, (r + 1) * sample.columns)) : [],
      pivotRows: p.pivotRows,
    });
  },
};

self.onmessage = async (message: MessageEvent<Request>) => {
  const { id, type, payload } = message.data;
  let response: Response;
  const transfer: Transferable[] = [];
  try {
    await ready;
    const result = await (handlers[type] as (p: unknown) => unknown)(payload);
    if (result && typeof result === 'object' && 'bytes' in result && result.bytes instanceof Uint8Array) transfer.push(result.bytes.buffer as ArrayBuffer);
    response = { id, ok: true, result };
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response, transfer);
};
