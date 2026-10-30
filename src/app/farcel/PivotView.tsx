import { useMemo, useRef, useState } from 'react';
import { chartFromPivot, layoutPivot } from '../../core/pivot.ts';
import type { PivotConfig, PivotTable } from '../../core/pivot.ts';
import { columnName } from '../../core/address.ts';
import { serializeTsv } from '../../core/tsv.ts';
import type { PivotResponse } from '../../engine/protocol.ts';
import { Grid } from './Grid.tsx';
import type { GridController } from './Grid.tsx';
import { Chart } from './Chart.tsx';
import type { ChartKind } from './Chart.tsx';
import { PivotPanel } from './PivotPanel.tsx';

export interface PivotDef { id: string; name: string; sheet: number; config: PivotConfig; chart: ChartKind; valueIndex: number }
export interface PivotState { result: PivotResponse | null; table: PivotTable | null; error: string | null; loading: boolean; progress: string | null; revision: number; configKey: string; version: number }

const ms = (value: number) => value >= 1000 ? `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : `${Math.round(value).toLocaleString('pt-BR')} ms`;

export function pivotInfo(result: PivotResponse): string {
  const groups = Math.max(1, result.rowGroups.length) * Math.max(1, result.columnGroups.length);
  return `${result.sourceRows.toLocaleString('pt-BR')} linhas de origem · ${result.includedRows.toLocaleString('pt-BR')} após filtros · ${groups.toLocaleString('pt-BR')} combinações · leitura ${ms(result.extractMs)} · agregação ${ms(result.aggregateMs)}`;
}

interface Props {
  pivot: PivotDef;
  sourceName: string;
  state: PivotState | undefined;
  fields: string[];
  rows: number;
  onChange(pivot: PivotDef): void;
  loadLabels(field: string): Promise<string[]>;
  onError(message: string): void;
  zoom?: number;
}

export function PivotView({ pivot, sourceName, state, fields, rows, onChange, loadLabels, onError, zoom = 1 }: Props) {
  const table = state?.table ?? null;
  const [tableKey] = useState(() => `pivot-${pivot.id}`);
  const version = useRef(0);
  const controller = useMemo<GridController>(() => {
    version.current++;
    const width = table?.width ?? 1;
    const labelCols = Math.max(1, pivot.config.rows.length);
    return {
      key: tableKey,
      revision: version.current,
      rowCount: Math.max(1, table?.rows.length ?? 1),
      columnCount: width,
      readOnly: true,
      columnWidth: c => (c <= labelCols ? 168 : 132),
      columnLabel: c => columnName(c),
      fetch: async (top, left, count, columns) => {
        const values: string[] = [];
        const kinds = new Uint8Array(count * columns);
        for (let r = 0; r < count; r++) for (let c = 0; c < columns; c++) {
          const row = top - 1 + r, col = left - 1 + c;
          const text = table?.rows[row]?.[col] ?? '';
          values.push(text);
          const numeric = table ? !Number.isNaN(table.numbers[row * table.width + col]) : false;
          kinds[r * columns + c] = text === '' ? 0 : numeric ? 1 : 2;
        }
        return { values, kinds };
      },
      copy: async rect => serializeTsv((table?.rows ?? []).slice(rect.top - 1, rect.bottom).map(r => r.slice(rect.left - 1, rect.right))),
    };
  }, [table, tableKey, pivot.config.rows.length]);

  const chart = useMemo(() => (state?.result ? chartFromPivot(state.result, Math.min(pivot.valueIndex, Math.max(0, state.result.values.length - 1))) : null), [state?.result, pivot.valueIndex]);
  const empty = pivot.config.values.length === 0 && pivot.config.rows.length === 0 && pivot.config.columns.length === 0;

  return (
    <div className="pivot-view">
      <div className="pivot-main">
        <header className="pivot-header">
          <div>
            <h2>{pivot.name}</h2>
            <p data-testid="pivot-info" data-status={state?.loading ? 'loading' : state?.error ? 'error' : state?.result ? 'ready' : 'empty'} data-version={state?.version ?? 0}>
              Origem: {sourceName}!A1 · {state?.loading ? (state.progress ?? 'Calculando…') : state?.error ? state.error : state?.result ? pivotInfo(state.result) : 'Sem campos'}
            </p>
          </div>
        </header>
        {empty ? (
          <div className="pivot-empty">
            <p>Escolha campos à direita: <strong>Linhas</strong> e <strong>Colunas</strong> agrupam, <strong>Valores</strong> somam ou contam, <strong>Filtros</strong> limitam as linhas.</p>
          </div>
        ) : (
          <>
            <div className="pivot-table" data-testid="pivot-table">
              <Grid controller={controller} zoom={zoom} label="Resultado da tabela dinâmica" onError={onError} />
            </div>
            <section className="pivot-chart" aria-label="Gráfico da tabela dinâmica">
              <header>
                <div className="segmented" role="group" aria-label="Tipo de gráfico">
                  <button className={pivot.chart === 'columns' ? 'on' : ''} onClick={() => onChange({ ...pivot, chart: 'columns' })}>Colunas</button>
                  <button className={pivot.chart === 'lines' ? 'on' : ''} onClick={() => onChange({ ...pivot, chart: 'lines' })}>Linhas</button>
                </div>
                {pivot.config.values.length > 1 && (
                  <select value={pivot.valueIndex} onChange={e => onChange({ ...pivot, valueIndex: Number(e.target.value) })} aria-label="Valor do gráfico">
                    {pivot.config.values.map((v, i) => <option key={v.field + v.aggregation} value={i}>{v.aggregation === 'sum' ? 'Soma' : 'Contagem'} de {v.field}</option>)}
                  </select>
                )}
                {chart && (chart.totalCategories > chart.categories.length || chart.totalSeries > chart.series.length) && (
                  <span className="panel-meta">Mostrando {chart.categories.length} de {chart.totalCategories.toLocaleString('pt-BR')} grupos e {chart.series.length} de {chart.totalSeries.toLocaleString('pt-BR')} séries</span>
                )}
              </header>
              {chart && <Chart data={chart} kind={pivot.chart} />}
            </section>
          </>
        )}
      </div>
      <PivotPanel fields={fields} rows={rows} config={pivot.config} loadLabels={loadLabels} onChange={config => onChange({ ...pivot, config, valueIndex: 0 })} />
    </div>
  );
}

export { layoutPivot };
