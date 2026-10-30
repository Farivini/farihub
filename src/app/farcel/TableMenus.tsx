import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { columnName, rectName } from '../../core/address.ts';
import type { Rect } from '../../core/address.ts';
import { editedCriterion, listChecked } from '../../core/table-ops.ts';
import type { FilterCriterion, FilterValue, FilterValues, ListBase, SortKey } from '../../core/table-ops.ts';
import type { MenuItem } from '../shell/Menu.tsx';
import { Dialog } from '../shell/Dialog.tsx';
import { Icon } from '../ui/Icon.tsx';

/** Keeps a floating box inside the window, measured after it is drawn. */
function useClamped(x: number, y: number) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) });
  }, [x, y]);
  return { box, position };
}

/** Closes on a click outside `box` or on Escape. */
function useDismiss(box: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    // Registered after the event that opened the box has finished, or it would close it.
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown));
    return () => { clearTimeout(timer); window.removeEventListener('mousedown', onDown); };
  }, [box, onClose]);
}

/** Actions on the selection, at the pointer. Same keyboard model as MenuButton. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  const { box, position } = useClamped(x, y);
  useDismiss(box, onClose);
  useLayoutEffect(() => { box.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus(); }, [box]);
  const onKey = (event: React.KeyboardEvent) => {
    const entries = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Tab') onClose();
  };
  return (
    <div ref={box} className="menu floating" role="menu" aria-label="Ações da seleção" data-testid="context-menu"
      style={{ left: position.left, top: position.top }} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
      {items.map(item => (
        <div key={item.id} role="none">
          {item.separatorBefore && <div className="menu-separator" role="separator" />}
          <button role="menuitem" className="menu-item" disabled={item.disabled} data-testid={`menu-${item.id}`}
            onClick={() => { onClose(); item.onSelect(); }}>
            <span className="menu-icon">{item.icon}</span>
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The list of a filter column: distinct values (as displayed) with counts, a search, and
 * sorting by this column. Applying turns the checked values into the column's criterion.
 */
export function FilterPopover({ x, y, title, criterion, load, onApply, onSort, onRemoveFilter, onClose }: {
  x: number; y: number; title: string;
  /** The column's criterion now (none: every value shown). */
  criterion: FilterCriterion | undefined;
  load(search: string): Promise<FilterValues>;
  /** null: no criterion for this column (every value shown). */
  onApply(criterion: Omit<FilterCriterion, 'column'> | null): void;
  onSort(descending: boolean): void;
  onRemoveFilter(): void;
  onClose(): void;
}) {
  const { box, position } = useClamped(x, y);
  useDismiss(box, onClose);
  const [search, setSearch] = useState('');
  const [list, setList] = useState<FilterValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Checks the person changed, kept across searches; every other value is as `base` says.
  const [base, setBase] = useState<ListBase>('current');
  const [changes, setChanges] = useState<ReadonlyMap<string, boolean>>(new Map());

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      load(search).then(result => { if (live) setList(result); }, e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    }, search ? 150 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [search, load]);

  const values = list?.values ?? [];
  const searching = search.trim() !== '';
  const checked = (v: FilterValue) => listChecked(v, base, changes);
  const allChecked = values.every(checked);
  const toggle = (v: FilterValue) => setChanges(c => new Map(c).set(v.text, !checked(v)));
  const toggleAll = () => {
    if (searching) {
      setChanges(c => { const next = new Map(c); for (const v of values) next.set(v.text, !allChecked); return next; });
    } else {
      // Every value, listed or not.
      setBase(allChecked ? 'none' : 'all');
      setChanges(new Map());
    }
  };

  const apply = () => {
    if (!list) return;
    onApply(editedCriterion(criterion, list, base, changes, searching));
    onClose();
  };

  return (
    <div ref={box} className="menu floating filter-popover" role="dialog" aria-label={`Filtro de ${title}`} data-testid="filter-popover"
      style={{ left: position.left, top: position.top }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}>
      <button className="menu-item" data-testid="filter-sort-asc" onClick={() => { onClose(); onSort(false); }}>
        <span className="menu-icon"><Icon name="sort" size={15} /></span><span className="menu-label">Classificar de A a Z</span>
      </button>
      <button className="menu-item" data-testid="filter-sort-desc" onClick={() => { onClose(); onSort(true); }}>
        <span className="menu-icon"><Icon name="sort" size={15} /></span><span className="menu-label">Classificar de Z a A</span>
      </button>
      <div className="menu-separator" role="separator" />
      <input className="menu-search" placeholder="Buscar" aria-label="Buscar valores" data-testid="filter-search" autoFocus
        value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') apply(); }} />
      {error && <p className="menu-empty">{error}</p>}
      {!list && !error && <p className="menu-empty">Lendo valores…</p>}
      {list && (
        <div className="filter-values" data-testid="filter-values">
          <label className="filter-value all">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} data-testid="filter-all" />
            <span>{searching ? 'Selecionar resultados' : 'Selecionar tudo'}</span>
          </label>
          {values.map(v => (
            <label key={v.text} className="filter-value">
              <input type="checkbox" checked={checked(v)} onChange={() => toggle(v)} />
              <span className={v.text === '' ? 'empty' : ''}>{v.text === '' ? '(Vazias)' : v.text}</span>
              <em>{v.count.toLocaleString('pt-BR')}</em>
            </label>
          ))}
          {values.length === 0 && <p className="menu-empty">Nenhum valor encontrado.</p>}
        </div>
      )}
      {list?.truncated && <p className="menu-empty">Mostrando {values.length.toLocaleString('pt-BR')} de {list.distinct.toLocaleString('pt-BR')} valores; use a busca.</p>}
      <div className="filter-actions">
        <button type="button" className="link" data-testid="filter-remove" onClick={() => { onClose(); onRemoveFilter(); }}>Remover filtro</button>
        <span />
        <button type="button" onClick={onClose}>Cancelar</button>
        <button type="button" className="primary" data-testid="filter-apply" disabled={!list} onClick={apply}>Aplicar</button>
      </div>
    </div>
  );
}

/** Multi-level sort of a range, with or without a header row. */
export function SortDialog({ range, header: initialHeader, headerLabels, keys: initialKeys, onSort, onCancel }: {
  range: Rect;
  header: boolean;
  /** Text of the first row, per column of the range. */
  headerLabels: string[];
  keys: SortKey[];
  onSort(header: boolean, keys: SortKey[]): void;
  onCancel(): void;
}) {
  const [header, setHeader] = useState(initialHeader);
  const [keys, setKeys] = useState<SortKey[]>(initialKeys);
  const columns = Array.from({ length: range.right - range.left + 1 }, (_, i) => range.left + i);
  const label = (column: number) => {
    const text = headerLabels[column - range.left];
    return header && text ? `${text} (${columnName(column)})` : `Coluna ${columnName(column)}`;
  };
  const used = new Set(keys.map(k => k.column));
  const update = (index: number, key: SortKey) => setKeys(k => k.map((x, i) => (i === index ? key : x)));
  const dataTop = header ? range.top + 1 : range.top;
  return (
    <Dialog title="Ordenar" testId="sort-dialog" onClose={onCancel} actions={<>
      <button type="button" onClick={onCancel}>Cancelar</button>
      <button type="button" className="primary" data-testid="sort-apply" disabled={!keys.length || dataTop >= range.bottom} onClick={() => onSort(header, keys)}>Ordenar</button>
    </>}>
      <p>Intervalo {rectName(range)} · as linhas inteiras do intervalo mudam de lugar juntas.</p>
      <label className="check">
        <input type="checkbox" checked={header} data-testid="sort-header" onChange={e => setHeader(e.target.checked)} />
        <span>A primeira linha é cabeçalho (fica no lugar)</span>
      </label>
      <ol className="sort-levels" data-testid="sort-levels">
        {keys.map((key, index) => (
          <li key={index}>
            <span className="sort-level-label">{index === 0 ? 'Ordenar por' : 'Depois por'}</span>
            <select value={key.column} aria-label={`Coluna do nível ${index + 1}`} onChange={e => update(index, { ...key, column: Number(e.target.value) })}>
              {columns.map(c => <option key={c} value={c} disabled={c !== key.column && used.has(c)}>{label(c)}</option>)}
            </select>
            <select value={key.descending ? 'desc' : 'asc'} aria-label={`Ordem do nível ${index + 1}`} onChange={e => update(index, { ...key, descending: e.target.value === 'desc' })}>
              <option value="asc">Crescente ↑</option>
              <option value="desc">Decrescente ↓</option>
            </select>
            <button type="button" className="icon-button" aria-label={`Remover nível ${index + 1}`} disabled={keys.length === 1}
              onClick={() => setKeys(k => k.filter((_, i) => i !== index))}><Icon name="close" size={12} /></button>
          </li>
        ))}
      </ol>
      <button type="button" className="link" data-testid="sort-add-level" disabled={used.size >= columns.length}
        onClick={() => setKeys(k => [...k, { column: columns.find(c => !used.has(c)) ?? range.left }])}>+ Adicionar nível</button>
      <p className="hint">Crescente: números e datas do menor ao maior, depois textos de A a Z. Células vazias ficam sempre no fim.</p>
    </Dialog>
  );
}
