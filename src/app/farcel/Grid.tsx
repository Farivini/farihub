import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { clampRef, normalizeRect } from '../../core/address.ts';
import type { CellRef, Rect } from '../../core/address.ts';
import { serializeTsv } from '../../core/tsv.ts';
import { measure } from '../perf.ts';

/** Kinds as produced by the engine viewport: 0 empty, 1 number, 2 text, 3 boolean, 4 error. */
/** Styles: see StyleFlag in the engine (bit 0 bold, bit 1 italic, bits 2-3 alignment). */
export interface GridData { values: string[]; kinds: Uint8Array; styles?: Uint8Array }
export type Direction = 'up' | 'down' | 'left' | 'right';

/** Everything the grid needs from its data owner. The grid itself holds no cell model, only a view cache. */
export interface GridController {
  /** Identity of the data shown; changing it resets the cache. */
  key: string;
  /** Bumped by the owner whenever data may have changed. */
  revision: number;
  rowCount: number;
  columnCount: number;
  readOnly: boolean;
  /** True while a write is in flight; the view cache may then be older than the engine. */
  pending?(): boolean;
  columnWidth(column: number): number;
  columnLabel(column: number): string;
  fetch(top: number, left: number, rows: number, columns: number): Promise<GridData>;
  copy(rect: Rect): Promise<string>;
  getInput?(cell: CellRef): Promise<string>;
  commit?(cell: CellRef, text: string): Promise<void>;
  clear?(rect: Rect): Promise<void>;
  paste?(origin: CellRef, text: string): Promise<void>;
  undo?(): Promise<void>;
  redo?(): Promise<void>;
  edge?(from: CellRef, direction: Direction): Promise<CellRef>;
}

export interface Selection { active: CellRef; rect: Rect }
/** `unit` is set when every number in the selection is shown as a percentage or in R$. */
export interface SelectionStats { count: number; numbers: number; sum: number; unit: '%' | 'R$' | null }

export interface GridHandle {
  focus(): void;
  select(active: CellRef, rect?: Rect): void;
  /** Statistics from cached values; null when part of the selection is not loaded or too large. */
  stats(rect: Rect): SelectionStats | null;
}

interface Props {
  controller: GridController;
  onSelection?(selection: Selection): void;
  /** Text being typed in the cell editor (null when not editing), mirrored by the formula bar. */
  onEditingText?(text: string | null): void;
  onError?(message: string): void;
  label?: string;
  /** 1 = 100%. Scales rows, columns and text. */
  zoom?: number;
}

const BASE_ROW_HEIGHT = 28;
const BASE_HEADER_HEIGHT = 30;
const BASE_ROW_HEADER_WIDTH = 56;
const BLOCK_ROWS = 64;
const BLOCK_COLS = 16;
const MAX_CACHE_BLOCKS = 600;
/** Browsers cap element height (~17.9M px in Firefox); larger sheets scroll proportionally. */
const MAX_SPACER = 15_000_000;
const FAMILY = '"Inter Variable", Inter, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';

interface Block { values: string[]; kinds: Uint8Array; styles?: Uint8Array; rows: number; columns: number; revision: number }
type EditMode = 'enter' | 'edit';

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Parses the engine's displayed number text (es locale: 1.234,5 / 12% / -3). */
function displayedNumber(text: string): number {
  const clean = text.replace(/\s/g, '').replace(/[%€$R]/g, '');
  if (!/^-?[\d.]*\d(,\d+)?$/.test(clean)) return NaN;
  const n = Number(clean.replace(/\./g, '').replace(',', '.'));
  return text.includes('%') ? n / 100 : n;
}

export const Grid = forwardRef<GridHandle, Props>(function Grid({ controller, onSelection, onEditingText, onError, label, zoom = 1 }, ref) {
  const ROW_HEIGHT = Math.round(BASE_ROW_HEIGHT * zoom);
  const HEADER_HEIGHT = Math.round(BASE_HEADER_HEIGHT * zoom);
  // Grows with the widest visible row number (999.990 needs more room than 12).
  const [rowHeaderWidth, setRowHeaderWidth] = useState(BASE_ROW_HEADER_WIDTH);
  const ROW_HEADER_WIDTH = Math.round(Math.max(BASE_ROW_HEADER_WIDTH, rowHeaderWidth) * zoom);
  const fontSize = Math.round(14 * zoom * 10) / 10;
  // Indexed by the bold and italic style bits.
  const FONTS = [`${fontSize}px ${FAMILY}`, `600 ${fontSize}px ${FAMILY}`, `italic ${fontSize}px ${FAMILY}`, `italic 600 ${fontSize}px ${FAMILY}`];
  const HEADER_FONT = `${Math.round(13 * zoom * 10) / 10}px ${FAMILY}`;
  const HEADER_FONT_ACTIVE = `600 ${Math.round(13 * zoom * 10) / 10}px ${FAMILY}`;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const widthOf = (column: number) => Math.round(ctrl.current.columnWidth(column) * zoomRef.current);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [editing, setEditing] = useState<{ mode: EditMode; cell: CellRef } | null>(null);
  const [selection, setSelection] = useState<Selection>({ active: { row: 1, column: 1 }, rect: { top: 1, left: 1, bottom: 1, right: 1 } });
  const anchorRef = useRef<CellRef>({ row: 1, column: 1 });
  const focusCellRef = useRef<CellRef>({ row: 1, column: 1 });
  const cache = useRef(new Map<number, Block>());
  const inflight = useRef(new Map<number, number>());
  const drawRequested = useRef(false);
  const ctrl = useRef(controller);
  ctrl.current = controller;
  const selectionRef = useRef(selection);
  /** Updates the ref immediately so key repeats before the next render see the new selection. */
  const applySelection = (next: Selection) => { selectionRef.current = next; setSelection(next); };
  const editingRef = useRef(editing);

  // Column geometry (prefix sums) for the current source.
  const geometry = useRef<{ key: string; offsets: Float64Array }>({ key: '', offsets: new Float64Array(1) });
  const offsets = (): Float64Array => {
    const c = ctrl.current;
    const key = `${c.key}:${c.columnCount}:${zoomRef.current}`;
    if (geometry.current.key !== key) {
      const result = new Float64Array(c.columnCount + 1);
      for (let col = 1; col <= c.columnCount; col++) result[col] = result[col - 1] + widthOf(col);
      geometry.current = { key, offsets: result };
    }
    return geometry.current.offsets;
  };
  const columnX = (column: number) => offsets()[column - 1];
  const columnAt = (x: number) => {
    const o = offsets();
    let lo = 1, hi = o.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (o[mid] <= x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  // Vertical scroll mapping between the (possibly capped) spacer and the content.
  const metrics = () => {
    const scroller = scrollerRef.current;
    const contentHeight = ctrl.current.rowCount * ROW_HEIGHT;
    const viewHeight = Math.max(0, size.height - HEADER_HEIGHT);
    const maxTop = Math.max(0, contentHeight - viewHeight);
    const spacerHeight = Math.min(contentHeight, MAX_SPACER) + HEADER_HEIGHT;
    const scrollable = Math.max(0, spacerHeight - (scroller?.clientHeight ?? size.height));
    const scrollTop = scroller?.scrollTop ?? 0;
    const contentTop = scrollable > 0 ? Math.min(maxTop, (scrollTop / scrollable) * maxTop) : 0;
    return { contentTop, contentLeft: scroller?.scrollLeft ?? 0, maxTop, scrollable, spacerHeight, viewHeight };
  };

  const visibleRange = () => {
    const m = metrics();
    const top = Math.floor(m.contentTop / ROW_HEIGHT) + 1;
    const rows = Math.ceil((size.height - HEADER_HEIGHT) / ROW_HEIGHT) + 1;
    const left = columnAt(m.contentLeft);
    let right = left;
    const limit = m.contentLeft + size.width - ROW_HEADER_WIDTH;
    while (right < ctrl.current.columnCount && columnX(right + 1) < limit) right++;
    return { top, bottom: Math.min(ctrl.current.rowCount, top + rows), left, right, ...m };
  };

  const drawRef = useRef<() => void>(() => {});
  const requestDraw = useCallback(() => {
    if (drawRequested.current) return;
    drawRequested.current = true;
    requestAnimationFrame(() => { drawRequested.current = false; drawRef.current(); });
  }, []);

  const blockKey = (blockRow: number, blockCol: number) => blockRow * 2048 + blockCol;

  /** Requests missing or stale visible blocks; returns true when everything visible is current. */
  const loadVisible = (): boolean => {
    const c = ctrl.current;
    let settled = true;
    const v = visibleRange();
    const b0 = Math.floor((v.top - 1) / BLOCK_ROWS), b1 = Math.floor((v.bottom - 1) / BLOCK_ROWS);
    const c0 = Math.floor((v.left - 1) / BLOCK_COLS), c1 = Math.floor((v.right - 1) / BLOCK_COLS);
    for (let br = b0; br <= b1; br++) {
      for (let bc = c0; bc <= c1; bc++) {
        const key = blockKey(br, bc);
        const block = cache.current.get(key);
        if (block && block.revision === c.revision) continue;
        settled = false;
        if (inflight.current.get(key) === c.revision) continue;
        inflight.current.set(key, c.revision);
        const top = br * BLOCK_ROWS + 1, left = bc * BLOCK_COLS + 1;
        const rows = Math.min(BLOCK_ROWS, c.rowCount - top + 1), columns = Math.min(BLOCK_COLS, c.columnCount - left + 1);
        const revision = c.revision;
        const sourceKey = c.key;
        const started = performance.now();
        c.fetch(top, left, rows, columns).then(data => {
          measure('grid:fetch', started, { top, left, rows, columns, source: sourceKey });
          if (ctrl.current.key !== sourceKey) return;
          if (inflight.current.get(key) === revision) inflight.current.delete(key);
          const existing = cache.current.get(key);
          if (existing && existing.revision > revision) return;
          cache.current.delete(key);
          cache.current.set(key, { ...data, rows, columns, revision });
          if (cache.current.size > MAX_CACHE_BLOCKS) {
            for (const old of cache.current.keys()) {
              if (cache.current.size <= MAX_CACHE_BLOCKS * 0.8) break;
              const oldRow = Math.floor(old / 2048), oldCol = old % 2048;
              if (oldRow >= b0 && oldRow <= b1 && oldCol >= c0 && oldCol <= c1) continue;
              cache.current.delete(old);
            }
          }
          requestDraw();
        }, error => {
          inflight.current.delete(key);
          onError?.(error instanceof Error ? error.message : String(error));
        });
      }
    }
    return settled;
  };

  const cellValue = (row: number, column: number): { value: string; kind: number; style: number } | null => {
    const block = cache.current.get(blockKey(Math.floor((row - 1) / BLOCK_ROWS), Math.floor((column - 1) / BLOCK_COLS)));
    if (!block) return null;
    const r = (row - 1) % BLOCK_ROWS, c = (column - 1) % BLOCK_COLS;
    if (r >= block.rows || c >= block.columns) return null;
    const i = r * block.columns + c;
    return { value: block.values[i], kind: block.kinds[i], style: block.styles?.[i] ?? 0 };
  };

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0) return;
    const drawStarted = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = {
      bg: css('--grid-bg'), line: css('--grid-line'), header: css('--grid-header'), headerText: css('--text-3'),
      headerActive: css('--grid-header-active'), text: css('--text-1'), accent: css('--accent'),
      selection: css('--grid-selection'), error: css('--danger'), muted: css('--text-3'), rowActive: css('--grid-row-active'),
    };
    const v = visibleRange();
    const c = ctrl.current;
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, size.width, size.height);
    const offsetY = v.contentTop - (v.top - 1) * ROW_HEIGHT;
    const yOf = (row: number) => HEADER_HEIGHT + (row - v.top) * ROW_HEIGHT - offsetY;
    const xOf = (column: number) => ROW_HEADER_WIDTH + columnX(column) - v.contentLeft;
    const sel = selectionRef.current;

    // Selection fill
    const rect = sel.rect;
    if (rect.bottom >= v.top && rect.top <= v.bottom && rect.right >= v.left && rect.left <= v.right) {
      const x0 = Math.max(ROW_HEADER_WIDTH, xOf(Math.max(rect.left, v.left)));
      const x1 = xOf(Math.min(rect.right, v.right) + 1);
      const y0 = Math.max(HEADER_HEIGHT, yOf(Math.max(rect.top, v.top)));
      const y1 = yOf(Math.min(rect.bottom, v.bottom) + 1);
      ctx.fillStyle = colors.selection;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      // The active cell stays clear inside a range, as in Excel.
      if (rect.top !== rect.bottom || rect.left !== rect.right) {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(xOf(sel.active.column), yOf(sel.active.row), widthOf(sel.active.column), ROW_HEIGHT);
      }
    }

    // Cells
    ctx.textBaseline = 'middle';
    let currentFont = '';
    for (let row = v.top; row <= v.bottom; row++) {
      const y = yOf(row);
      for (let column = v.left; column <= v.right; column++) {
        const cell = cellValue(row, column);
        if (!cell || cell.kind === 0 || cell.value === '') continue;
        const x = xOf(column);
        const w = widthOf(column);
        const font = FONTS[cell.style & 3];
        if (font !== currentFont) { ctx.font = font; currentFont = font; }
        const text = cell.value.includes('\n') ? cell.value.split('\n')[0] + ' …' : cell.value;
        const width = ctx.measureText(text).width;
        ctx.fillStyle = cell.kind === 4 ? colors.error : colors.text;
        const pad = 7 * zoomRef.current;
        const clip = width > w - pad * 2;
        // Alignment: explicit style first; otherwise numbers right, booleans and errors centered, text left.
        const explicit = (cell.style & 12) >> 2;
        const align = explicit === 1 ? 'left' : explicit === 2 ? 'center' : explicit === 3 ? 'right'
          : cell.kind === 1 ? 'right' : cell.kind === 3 || cell.kind === 4 ? 'center' : 'left';
        if (clip) { ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y, w - 2, ROW_HEIGHT); ctx.clip(); }
        const tx = clip || align === 'left' ? x + pad : align === 'right' ? x + w - pad - width : x + (w - width) / 2;
        ctx.fillText(text, tx, y + ROW_HEIGHT / 2 + 0.5);
        if (clip) ctx.restore();
      }
    }

    // Grid lines
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let row = v.top; row <= v.bottom + 1; row++) {
      const y = Math.round(yOf(row)) + 0.5;
      ctx.moveTo(ROW_HEADER_WIDTH, y); ctx.lineTo(size.width, y);
    }
    for (let column = v.left; column <= v.right + 1; column++) {
      const x = Math.round(xOf(column)) - 0.5;
      ctx.moveTo(x, HEADER_HEIGHT); ctx.lineTo(x, size.height);
    }
    ctx.stroke();

    // Selection border: the whole range in accent, 2px.
    if (rect.bottom >= v.top && rect.top <= v.bottom + 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ROW_HEADER_WIDTH, HEADER_HEIGHT, size.width, size.height);
      ctx.clip();
      const x0 = xOf(rect.left), x1 = xOf(rect.right + 1), y0 = yOf(rect.top), y1 = yOf(rect.bottom + 1);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.round(x0) + 1, Math.round(y0) + 1, Math.round(x1 - x0) - 2, Math.round(y1 - y0) - 2);
      ctx.restore();
    }

    // Headers
    ctx.fillStyle = colors.header;
    ctx.fillRect(0, 0, size.width, HEADER_HEIGHT);
    ctx.fillRect(0, 0, ROW_HEADER_WIDTH, size.height);
    const wholeRows = rect.left === 1 && rect.right === c.columnCount;
    const wholeColumns = rect.top === 1 && rect.bottom === c.rowCount;
    for (let column = v.left; column <= v.right; column++) {
      const x = xOf(column), w = widthOf(column);
      const active = column >= rect.left && column <= rect.right && !wholeRows;
      if (active) {
        ctx.fillStyle = colors.headerActive;
        ctx.fillRect(Math.max(x, ROW_HEADER_WIDTH), 0, w, HEADER_HEIGHT);
        ctx.fillStyle = colors.accent;
        ctx.fillRect(Math.max(x, ROW_HEADER_WIDTH), HEADER_HEIGHT - 2, w, 2);
      }
      ctx.font = active ? HEADER_FONT_ACTIVE : HEADER_FONT;
      ctx.fillStyle = active ? colors.accent : colors.headerText;
      const label = c.columnLabel(column);
      const lw = ctx.measureText(label).width;
      if (x + w > ROW_HEADER_WIDTH) ctx.fillText(label, x + (w - lw) / 2, HEADER_HEIGHT / 2 + 0.5);
    }
    ctx.fillStyle = colors.header;
    ctx.fillRect(0, 0, ROW_HEADER_WIDTH, HEADER_HEIGHT);
    for (let row = v.top; row <= v.bottom; row++) {
      const y = yOf(row);
      if (y + ROW_HEIGHT < HEADER_HEIGHT) continue;
      const active = row >= rect.top && row <= rect.bottom && !wholeColumns;
      if (active) { ctx.fillStyle = colors.rowActive; ctx.fillRect(0, Math.max(y, HEADER_HEIGHT), ROW_HEADER_WIDTH, ROW_HEIGHT); }
      ctx.font = active ? HEADER_FONT_ACTIVE : HEADER_FONT;
      ctx.fillStyle = active ? colors.text : colors.headerText;
      const label = row.toLocaleString('pt-BR');
      const lw = ctx.measureText(label).width;
      if (y >= HEADER_HEIGHT - ROW_HEIGHT / 2) ctx.fillText(label, (ROW_HEADER_WIDTH - lw) / 2, y + ROW_HEIGHT / 2 + 0.5);
    }
    ctx.font = HEADER_FONT_ACTIVE;
    const needed = Math.ceil((ctx.measureText(v.bottom.toLocaleString('pt-BR')).width + 22) / zoomRef.current);
    if (needed !== rowHeaderWidth && Math.max(needed, BASE_ROW_HEADER_WIDTH) !== Math.max(rowHeaderWidth, BASE_ROW_HEADER_WIDTH)) setRowHeaderWidth(needed);
    ctx.strokeStyle = colors.line;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_HEIGHT - 0.5); ctx.lineTo(size.width, HEADER_HEIGHT - 0.5);
    ctx.moveTo(ROW_HEADER_WIDTH - 0.5, 0); ctx.lineTo(ROW_HEADER_WIDTH - 0.5, size.height);
    ctx.stroke();
    const settled = loadVisible() && !(c.pending?.() ?? false);
    // Observable state for automation: true once the visible cells reflect the latest revision.
    rootRef.current?.setAttribute('data-settled', String(settled));
    measure('grid:draw', drawStarted, { top: v.top, bottom: v.bottom, left: v.left, right: v.right, source: c.key, revision: c.revision });
  }

  drawRef.current = draw;

  // Resize
  useLayoutEffect(() => {
    const root = rootRef.current!;
    const observer = new ResizeObserver(() => setSize({ width: root.clientWidth, height: root.clientHeight }));
    observer.observe(root);
    setSize({ width: root.clientWidth, height: root.clientHeight });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    draw();
  }, [size]);

  // Source identity change: reset cache, selection and scroll.
  const lastKey = useRef(controller.key);
  useEffect(() => {
    if (lastKey.current !== controller.key) {
      lastKey.current = controller.key;
      cache.current.clear();
      inflight.current.clear();
      editingRef.current = null;
      setEditing(null);
      moveTo({ row: 1, column: 1 }, false);
      if (scrollerRef.current) { scrollerRef.current.scrollTop = 0; scrollerRef.current.scrollLeft = 0; }
    }
    requestDraw();
  }, [controller.key, controller.revision, controller.rowCount, controller.columnCount]);

  useEffect(() => { requestDraw(); onSelection?.(selection); }, [selection]);
  useEffect(() => { requestDraw(); scrollIntoView(selectionRef.current.active); }, [zoom]);
  useEffect(() => { requestDraw(); }, [rowHeaderWidth]);

  const scrollIntoView = (cell: CellRef) => {
    const scroller = scrollerRef.current;
    if (!scroller || size.width === 0) return; // not laid out yet
    const m = metrics();
    const y = (cell.row - 1) * ROW_HEIGHT;
    let contentTop = m.contentTop;
    if (y < contentTop) contentTop = y;
    else if (y + ROW_HEIGHT > contentTop + m.viewHeight) contentTop = y + ROW_HEIGHT - m.viewHeight;
    if (contentTop !== m.contentTop && m.maxTop > 0) scroller.scrollTop = Math.ceil((contentTop / m.maxTop) * m.scrollable);
    const x = columnX(cell.column);
    const w = widthOf(cell.column);
    const viewWidth = size.width - ROW_HEADER_WIDTH;
    if (x < scroller.scrollLeft) scroller.scrollLeft = x;
    else if (x + w > scroller.scrollLeft + viewWidth) scroller.scrollLeft = x + w - viewWidth;
  };

  function moveTo(cell: CellRef, extend: boolean) {
    const c = ctrl.current;
    const target = { row: Math.min(c.rowCount, clampRef(cell).row), column: Math.min(c.columnCount, clampRef(cell).column) };
    if (extend) {
      focusCellRef.current = target;
      applySelection({ active: anchorRef.current, rect: normalizeRect(anchorRef.current, target) });
    } else {
      anchorRef.current = target;
      focusCellRef.current = target;
      applySelection({ active: target, rect: { top: target.row, left: target.column, bottom: target.row, right: target.column } });
    }
    scrollIntoView(target);
  }

  const pageRows = () => Math.max(1, Math.floor((size.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1);

  const report = (promise: Promise<unknown> | undefined) => {
    promise?.catch(error => onError?.(error instanceof Error ? error.message : String(error)));
  };

  const beginEdit = async (mode: EditMode, initial?: string) => {
    const c = ctrl.current;
    if (c.readOnly || !c.commit) return;
    const cell = selectionRef.current.active;
    scrollIntoView(cell);
    const editor = editorRef.current!;
    if (initial === undefined) {
      const text = c.getInput ? await c.getInput(cell) : '';
      editor.value = text;
      editor.setSelectionRange(text.length, text.length);
    } else {
      editor.value = initial;
    }
    editingRef.current = { mode, cell }; // keys may arrive before the next render
    setEditing({ mode, cell });
    onEditingText?.(editor.value);
  };

  const finishEdit = async (commit: boolean, move?: Direction) => {
    const state = editingRef.current;
    const editor = editorRef.current!;
    if (!state) return;
    const text = editor.value;
    editor.value = '';
    editingRef.current = null;
    setEditing(null);
    onEditingText?.(null);
    if (commit) report(ctrl.current.commit?.(state.cell, text));
    if (move) step(move, false);
  };

  const step = (direction: Direction, extend: boolean) => {
    const from = extend ? focusCellRef.current : selectionRef.current.active;
    const delta = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[direction];
    moveTo({ row: from.row + delta[0], column: from.column + delta[1] }, extend);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const c = ctrl.current;
    const ctrlKey = event.ctrlKey || event.metaKey;
    const state = editingRef.current;
    if (event.nativeEvent.isComposing) return;
    if (state) {
      if (event.key === 'Enter' && event.altKey) {
        // Line break inside the cell, as Excel.
        event.preventDefault();
        const editor = editorRef.current!;
        const pos = editor.selectionStart;
        editor.value = editor.value.slice(0, pos) + '\n' + editor.value.slice(editor.selectionEnd);
        editor.setSelectionRange(pos + 1, pos + 1);
        onEditingText?.(editor.value);
      } else if (event.key === 'Enter') { event.preventDefault(); void finishEdit(true, event.shiftKey ? 'up' : 'down'); }
      else if (event.key === 'Tab') { event.preventDefault(); void finishEdit(true, event.shiftKey ? 'left' : 'right'); }
      else if (event.key === 'Escape') { event.preventDefault(); void finishEdit(false); }
      else if (state.mode === 'enter' && event.key.startsWith('Arrow')) {
        event.preventDefault();
        void finishEdit(true, event.key.slice(5).toLowerCase() as Direction);
      }
      return;
    }
    const arrow = event.key.startsWith('Arrow') ? event.key.slice(5).toLowerCase() as Direction : null;
    if (arrow) {
      event.preventDefault();
      if (ctrlKey && c.edge) {
        const from = event.shiftKey ? focusCellRef.current : selectionRef.current.active;
        const extend = event.shiftKey;
        c.edge(from, arrow).then(target => moveTo(target, extend), error => onError?.(String(error)));
      } else step(arrow, event.shiftKey);
      return;
    }
    if (ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'z') { event.preventDefault(); report(event.shiftKey ? c.redo?.() : c.undo?.()); }
      else if (key === 'y') { event.preventDefault(); report(c.redo?.()); }
      else if (key === 'home') { event.preventDefault(); moveTo({ row: 1, column: 1 }, false); }
      else if (key === 'a') {
        event.preventDefault();
        anchorRef.current = { row: 1, column: 1 };
        focusCellRef.current = { row: c.rowCount, column: c.columnCount };
        applySelection({ active: { row: 1, column: 1 }, rect: { top: 1, left: 1, bottom: c.rowCount, right: c.columnCount } });
      }
      return; // c, v, x reach the clipboard events
    }
    switch (event.key) {
      case 'Enter': event.preventDefault(); step(event.shiftKey ? 'up' : 'down', false); break;
      case 'Tab': event.preventDefault(); step(event.shiftKey ? 'left' : 'right', false); break;
      case 'F2': event.preventDefault(); void beginEdit('edit'); break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (!c.readOnly) report(c.clear?.(selectionRef.current.rect));
        break;
      case 'PageDown': event.preventDefault(); moveTo({ row: selectionRef.current.active.row + pageRows(), column: selectionRef.current.active.column }, event.shiftKey); break;
      case 'PageUp': event.preventDefault(); moveTo({ row: selectionRef.current.active.row - pageRows(), column: selectionRef.current.active.column }, event.shiftKey); break;
      case 'Home': event.preventDefault(); moveTo({ row: selectionRef.current.active.row, column: 1 }, event.shiftKey); break;
      case 'Escape': break;
    }
  };

  const onInput = () => {
    const editor = editorRef.current!;
    if (!editingRef.current) {
      if (ctrl.current.readOnly) { editor.value = ''; return; }
      void beginEdit('enter', editor.value);
    } else onEditingText?.(editor.value);
  };

  const onCompositionStart = () => {
    if (!editingRef.current && !ctrl.current.readOnly) void beginEdit('enter', '');
  };

  const onCopy = (event: React.ClipboardEvent) => {
    if (editingRef.current) return; // native copy inside the editor
    event.preventDefault();
    const rect = selectionRef.current.rect;
    const rows = rect.bottom - rect.top + 1, cols = rect.right - rect.left + 1;
    // Small loaded selections are answered synchronously from the view cache; the engine
    // copy still runs to keep its internal clipboard (formulas with relative references).
    if (rows * cols <= 20_000 && !(ctrl.current.pending?.() ?? false)) {
      const lines: string[][] = [];
      let complete = true;
      for (let r = rect.top; r <= rect.bottom && complete; r++) {
        const line: string[] = [];
        for (let col = rect.left; col <= rect.right; col++) {
          const cell = cellValue(r, col);
          if (!cell || cache.current.get(blockKey(Math.floor((r - 1) / BLOCK_ROWS), Math.floor((col - 1) / BLOCK_COLS)))!.revision !== ctrl.current.revision) { complete = false; break; }
          line.push(cell.value);
        }
        lines.push(line);
      }
      if (complete) {
        event.clipboardData.setData('text/plain', serializeTsv(lines));
        report(ctrl.current.copy(rect));
        return;
      }
    }
    report(ctrl.current.copy(rect).then(text => navigator.clipboard.writeText(text)));
  };

  const onPaste = (event: React.ClipboardEvent) => {
    if (editingRef.current) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (!text || ctrl.current.readOnly) return;
    const rect = selectionRef.current.rect;
    report(ctrl.current.paste?.({ row: rect.top, column: rect.left }, text));
  };

  const onCut = (event: React.ClipboardEvent) => {
    // Cut is copy + clear in this version (Excel moves on paste; not implemented yet).
    onCopy(event);
    if (!editingRef.current && !ctrl.current.readOnly) report(ctrl.current.clear?.(selectionRef.current.rect));
  };

  // Mouse
  const hit = (event: { clientX: number; clientY: number }) => {
    const bounds = scrollerRef.current!.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const m = metrics();
    const row = y < HEADER_HEIGHT ? 0 : Math.floor((m.contentTop + y - HEADER_HEIGHT) / ROW_HEIGHT) + 1;
    const column = x < ROW_HEADER_WIDTH ? 0 : columnAt(m.contentLeft + x - ROW_HEADER_WIDTH);
    return { row: Math.min(row, ctrl.current.rowCount), column: Math.min(column, ctrl.current.columnCount), x, y };
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const bounds = scrollerRef.current!.getBoundingClientRect();
    // Ignore clicks on the native scrollbars.
    if (event.clientX - bounds.left > scrollerRef.current!.clientWidth || event.clientY - bounds.top > scrollerRef.current!.clientHeight) return;
    event.preventDefault();
    if (editingRef.current) void finishEdit(true);
    const h = hit(event);
    const c = ctrl.current;
    if (h.row === 0 && h.column === 0) return;
    if (h.row === 0) {
      anchorRef.current = { row: 1, column: h.column };
      applySelection({ active: { row: 1, column: h.column }, rect: { top: 1, bottom: c.rowCount, left: h.column, right: h.column } });
    } else if (h.column === 0) {
      anchorRef.current = { row: h.row, column: 1 };
      applySelection({ active: { row: h.row, column: 1 }, rect: { top: h.row, bottom: h.row, left: 1, right: c.columnCount } });
    } else {
      moveTo({ row: h.row, column: h.column }, event.shiftKey);
      const onMove = (move: MouseEvent) => {
        const target = hit(move);
        if (target.row >= 1 && target.column >= 1) moveTo({ row: target.row, column: target.column }, true);
      };
      const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
    editorRef.current?.focus();
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    const h = hit(event);
    if (h.row >= 1 && h.column >= 1) void beginEdit('edit');
  };

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    select: (active, rect) => {
      anchorRef.current = active;
      focusCellRef.current = rect ? { row: rect.bottom, column: rect.right } : active;
      applySelection({ active, rect: rect ?? { top: active.row, left: active.column, bottom: active.row, right: active.column } });
      scrollIntoView(active);
    },
    stats: rect => {
      const cells = (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
      if (cells > 50_000) return null;
      let count = 0, numbers = 0, sum = 0, percents = 0, reais = 0;
      for (let r = rect.top; r <= rect.bottom; r++) for (let col = rect.left; col <= rect.right; col++) {
        const cell = cellValue(r, col);
        if (!cell) return null;
        if (cell.kind === 0) continue;
        count++;
        if (cell.kind === 1) {
          const n = displayedNumber(cell.value);
          if (!Number.isNaN(n)) {
            numbers++; sum += n;
            if (cell.value.includes('%')) percents++;
            if (cell.value.includes('R$')) reais++;
          }
        }
      }
      return { count, numbers, sum, unit: numbers && percents === numbers ? '%' : numbers && reais === numbers ? 'R$' : null };
    },
  }));

  // Editor geometry
  const m = size.width ? metrics() : null;
  const editorCell = editing?.cell ?? selection.active;
  const editorStyle: React.CSSProperties = m ? {
    left: ROW_HEADER_WIDTH + columnX(editorCell.column) - m.contentLeft,
    top: HEADER_HEIGHT + (editorCell.row - 1) * ROW_HEIGHT - m.contentTop,
    minWidth: widthOf(editorCell.column),
    font: FONTS[0],
    lineHeight: `${ROW_HEIGHT - 6}px`,
    height: ROW_HEIGHT,
  } : {};
  const editorLines = editing ? (editorRef.current?.value.split('\n').length ?? 1) : 1;
  if (editing && editorLines > 1) editorStyle.height = ROW_HEIGHT + (editorLines - 1) * (ROW_HEIGHT - 6);

  return (
    <div className="grid-root" ref={rootRef} aria-label={label}>
      <canvas ref={canvasRef} className="grid-canvas" />
      <div
        className="grid-scroller"
        ref={scrollerRef}
        onScroll={() => { requestDraw(); if (editingRef.current) setEditing({ ...editingRef.current }); }}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        data-testid="grid-scroller"
      >
        <div style={{ width: ROW_HEADER_WIDTH + offsets()[controller.columnCount], height: m?.spacerHeight ?? 0 }} />
      </div>
      <textarea
        ref={editorRef}
        className={editing ? 'grid-editor editing' : 'grid-editor'}
        style={editorStyle}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Editor de célula"
        data-testid="cell-editor"
        onKeyDown={onKeyDown}
        onInput={onInput}
        onCompositionStart={onCompositionStart}
        onCopy={onCopy}
        onPaste={onPaste}
        onCut={onCut}
        onBlur={() => { if (editingRef.current) void finishEdit(true); }}
      />
    </div>
  );
});
