import { useEffect, useMemo, useState } from 'react';
import type { PivotConfig, ValueField } from '../../core/pivot.ts';
import { Icon } from '../ui/Icon.tsx';

type Zone = 'filters' | 'columns' | 'rows' | 'values';
const ZONES: Array<{ zone: Zone; title: string }> = [
  { zone: 'filters', title: 'Filtros' },
  { zone: 'columns', title: 'Colunas' },
  { zone: 'rows', title: 'Linhas' },
  { zone: 'values', title: 'Valores' },
];

function without(config: PivotConfig, field: string, zone?: Zone): PivotConfig {
  return {
    rows: zone && zone !== 'rows' ? config.rows : config.rows.filter(f => f !== field),
    columns: zone && zone !== 'columns' ? config.columns : config.columns.filter(f => f !== field),
    values: zone && zone !== 'values' ? config.values : config.values.filter(v => v.field !== field),
    filters: zone && zone !== 'filters' ? config.filters : config.filters.filter(f => f.field !== field),
  };
}

/** Adds a field to a zone. A field sits in one of rows/columns/filters at a time; values are independent. */
export function placeField(config: PivotConfig, field: string, zone: Zone): PivotConfig {
  if (zone === 'values') {
    if (config.values.some(v => v.field === field)) return config;
    return { ...config, values: [...config.values, { field, aggregation: 'sum' }] };
  }
  const base = { ...config, rows: config.rows.filter(f => f !== field), columns: config.columns.filter(f => f !== field), filters: config.filters.filter(f => f.field !== field) };
  if (zone === 'rows') return { ...base, rows: [...base.rows, field] };
  if (zone === 'columns') return { ...base, columns: [...base.columns, field] };
  const previous = config.filters.find(f => f.field === field);
  return { ...base, filters: [...base.filters, previous ?? { field, excluded: [] }] };
}

interface Props {
  fields: string[];
  rows: number;
  config: PivotConfig;
  onChange(config: PivotConfig): void;
  loadLabels(field: string): Promise<string[]>;
}

export function PivotPanel({ fields, rows, config, onChange, loadLabels }: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Zone | null>(null);
  const [filterOpen, setFilterOpen] = useState<string | null>(null);
  const used = useMemo(() => new Set([...config.rows, ...config.columns, ...config.values.map(v => v.field), ...config.filters.map(f => f.field)]), [config]);

  const drop = (zone: Zone, event: React.DragEvent) => {
    event.preventDefault();
    const field = event.dataTransfer.getData('text/x-farcel-field') || dragging;
    setOver(null);
    setDragging(null);
    if (field) onChange(placeField(config, field, zone));
  };

  const chips = (zone: Zone) => {
    if (zone === 'values') {
      return config.values.map((value: ValueField) => (
        <div className="chip" key={value.field} draggable onDragStart={e => { e.dataTransfer.setData('text/x-farcel-field', value.field); setDragging(value.field); }}>
          <button
            className="chip-agg"
            title="Alternar entre soma e contagem"
            onClick={() => onChange({ ...config, values: config.values.map(v => v.field === value.field ? { ...v, aggregation: v.aggregation === 'sum' ? 'count' : 'sum' } : v) })}
          >{value.aggregation === 'sum' ? 'Soma' : 'Contagem'}</button>
          <span className="chip-name">{value.field}</span>
          <button className="chip-remove" aria-label={`Remover ${value.field} de Valores`} onClick={() => onChange(without(config, value.field, 'values'))}><Icon name="close" size={13} /></button>
        </div>
      ));
    }
    const list = zone === 'filters' ? config.filters.map(f => f.field) : zone === 'rows' ? config.rows : config.columns;
    return list.map(field => {
      const filter = config.filters.find(f => f.field === field);
      return (
        <div className="chip" key={field} draggable onDragStart={e => { e.dataTransfer.setData('text/x-farcel-field', field); setDragging(field); }}>
          {zone === 'filters' && (
            <button className="chip-agg" onClick={() => setFilterOpen(filterOpen === field ? null : field)} aria-expanded={filterOpen === field}>
              <Icon name="filter" size={13} />{filter && filter.excluded.length ? ` −${filter.excluded.length}` : ''}
            </button>
          )}
          <span className="chip-name">{field}</span>
          <button className="chip-remove" aria-label={`Remover ${field}`} onClick={() => onChange(without(config, field, zone))}><Icon name="close" size={13} /></button>
        </div>
      );
    });
  };

  return (
    <aside className="pivot-panel" aria-label="Campos da tabela dinâmica">
      <header className="panel-title">
        <span>Campos</span>
        <span className="panel-meta">{rows.toLocaleString('pt-BR')} linhas</span>
      </header>
      {fields.length === 0 && <p className="panel-hint">A tabela dinâmica usa os dados a partir de A1 da planilha de origem, com cabeçalhos na linha 1.</p>}
      <ul className="field-list">
        {fields.map(field => (
          <li key={field}>
            <button
              className={used.has(field) ? 'field used' : 'field'}
              draggable
              onDragStart={e => { e.dataTransfer.setData('text/x-farcel-field', field); setDragging(field); }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onClick={() => onChange(used.has(field) ? without(config, field) : placeField(config, field, config.rows.length ? 'values' : 'rows'))}
              title="Arraste para uma área ou clique para adicionar"
              data-testid={`field-${field}`}
            >
              <span className="field-check" aria-hidden="true" />{field}
            </button>
          </li>
        ))}
      </ul>
      <div className="zones">
        {ZONES.map(({ zone, title }) => (
          <section
            key={zone}
            className={over === zone ? 'zone over' : 'zone'}
            onDragOver={e => { e.preventDefault(); setOver(zone); }}
            onDragLeave={() => setOver(o => (o === zone ? null : o))}
            onDrop={e => drop(zone, e)}
            data-testid={`zone-${zone}`}
          >
            <h4>{title}</h4>
            <div className="zone-body">{chips(zone)}</div>
          </section>
        ))}
      </div>
      {filterOpen && (
        <FilterList
          key={filterOpen}
          field={filterOpen}
          excluded={config.filters.find(f => f.field === filterOpen)?.excluded ?? []}
          load={loadLabels}
          onClose={() => setFilterOpen(null)}
          onChange={excluded => onChange({ ...config, filters: config.filters.map(f => f.field === filterOpen ? { ...f, excluded } : f) })}
        />
      )}
    </aside>
  );
}

function FilterList({ field, excluded, load, onChange, onClose }: {
  field: string; excluded: string[]; load(field: string): Promise<string[]>; onChange(excluded: string[]): void; onClose(): void;
}) {
  const [labels, setLabels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => { load(field).then(setLabels, e => setError(String(e))); }, [field, load]);
  const hidden = new Set(excluded);
  const shown = (labels ?? []).filter(l => l.toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR')));
  const limit = 500;
  return (
    <div className="filter-list" role="dialog" aria-label={`Filtrar ${field}`}>
      <header><strong>{field}</strong><button className="icon-button" onClick={onClose} aria-label="Fechar filtro"><Icon name="close" size={14} /></button></header>
      {error && <p className="panel-hint error">{error}</p>}
      {!labels && !error && <p className="panel-hint">Lendo valores…</p>}
      {labels && (
        <>
          <input className="filter-search" placeholder="Buscar" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="filter-actions">
            <button onClick={() => onChange([])}>Todos</button>
            <button onClick={() => onChange([...labels])}>Nenhum</button>
          </div>
          <ul>
            {shown.slice(0, limit).map(label => (
              <li key={label}>
                <label>
                  <input
                    type="checkbox"
                    checked={!hidden.has(label)}
                    onChange={e => onChange(e.target.checked ? excluded.filter(x => x !== label) : [...excluded, label])}
                  />
                  {label}
                </label>
              </li>
            ))}
          </ul>
          {shown.length > limit && <p className="panel-hint">Mostrando {limit} de {shown.length.toLocaleString('pt-BR')} valores. Use a busca.</p>}
        </>
      )}
    </div>
  );
}
