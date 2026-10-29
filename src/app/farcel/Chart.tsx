import { useLayoutEffect, useRef, useState } from 'react';
import type { ChartData } from '../../core/pivot.ts';

export type ChartKind = 'columns' | 'lines';

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) max = min + 1;
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const error = (span / count) / step;
  const nice = step * (error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1);
  const ticks: number[] = [];
  for (let t = Math.floor(min / nice) * nice; t <= max + nice * 0.5; t += nice) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

/** SVG chart drawn from the aggregated pivot result. */
export function Chart({ data, kind }: { data: ChartData; kind: ChartKind }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ category: number; series: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const height = 260;
  const margin = { top: 16, right: 16, bottom: 56, left: 64 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const all = data.series.flatMap(s => s.values);
  if (!all.length) return <div ref={ref} className="chart-empty">Adicione um campo em Valores para ver o gráfico.</div>;
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const y = (v: number) => margin.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const band = plotW / data.categories.length;
  const groupW = band * 0.72;
  const barW = groupW / data.series.length;
  const xCenter = (i: number) => margin.left + band * i + band / 2;
  const label = (text: string) => (text.length > 14 ? text.slice(0, 13) + '…' : text);
  const hovered = hover ? { category: data.categories[hover.category], series: data.series[hover.series], value: data.series[hover.series].values[hover.category] } : null;

  return (
    <div ref={ref} className="chart">
      <svg width={width} height={height} role="img" aria-label={`Gráfico: ${data.valueLabel}`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={margin.left} x2={margin.left + plotW} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={margin.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{compact.format(t)}</text>
          </g>
        ))}
        {data.categories.map((category, i) => (
          <text key={category + i} x={xCenter(i)} y={margin.top + plotH + 16} className="chart-tick" textAnchor="middle">
            {band > 34 ? label(category) : ''}
            <title>{category}</title>
          </text>
        ))}
        {kind === 'columns'
          ? data.series.map((series, s) => series.values.map((value, i) => (
            <rect
              key={`${s}-${i}`}
              className="chart-bar"
              style={{ fill: `var(--series-${s % 8})` }}
              x={xCenter(i) - groupW / 2 + s * barW + 1}
              width={Math.max(1, barW - 2)}
              y={Math.min(y(value), y(0))}
              height={Math.abs(y(value) - y(0))}
              rx={3}
              onMouseEnter={() => setHover({ category: i, series: s })}
              onMouseLeave={() => setHover(null)}
            />
          )))
          : data.series.map((series, s) => (
            <g key={s}>
              <polyline
                className="chart-line"
                style={{ stroke: `var(--series-${s % 8})` }}
                points={series.values.map((v, i) => `${xCenter(i)},${y(v)}`).join(' ')}
              />
              {series.values.map((v, i) => (
                <circle key={i} cx={xCenter(i)} cy={y(v)} r={3.5} style={{ fill: `var(--series-${s % 8})` }}
                  onMouseEnter={() => setHover({ category: i, series: s })} onMouseLeave={() => setHover(null)} />
              ))}
            </g>
          ))}
        <line x1={margin.left} x2={margin.left + plotW} y1={y(0)} y2={y(0)} className="chart-axis" />
      </svg>
      <div className="chart-footer">
        <div className="chart-legend">
          {data.series.map((series, s) => (
            <span key={s}><i style={{ background: `var(--series-${s % 8})` }} />{series.name}</span>
          ))}
        </div>
        <div className="chart-readout" aria-live="polite">
          {hovered ? `${hovered.category} · ${hovered.series.name}: ${full.format(hovered.value)}` : data.valueLabel}
        </div>
      </div>
    </div>
  );
}
