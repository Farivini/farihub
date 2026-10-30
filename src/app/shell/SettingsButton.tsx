import { useEffect, useRef, useState } from 'react';
import type { EngineClient } from '../../engine/client.ts';
import type { EngineStats } from '../../engine/protocol.ts';
import { FORMAT_DESCRIPTION } from '../../core/file-format.ts';
import { ENGINE_LOCALE, IRONCALC_VERSION } from '../../engine/workbook-engine.ts';
import { Icon } from '../ui/Icon.tsx';

const mib = (bytes: number | null) => bytes === null ? '—' : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MiB`;

/** Gear in the rail: information about the engine and files of the visible workbook. */
export function SettingsButton({ client }: { client: EngineClient }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    client.call('stats').then(s => { if (live) setStats(s); }, () => {});
    const onDown = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => { live = false; window.removeEventListener('mousedown', onDown); };
  }, [open, client]);
  return (
    <span className="menu-anchor">
      <button ref={button} className="rail-button" aria-label="Ajustes e informações" title="Ajustes e informações"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)} data-testid="settings">
        <Icon name="gear" size={20} />
      </button>
      {open && (
        <div ref={panel} className="menu settings-panel right up" role="dialog" aria-label="Ajustes e informações"
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } }}>
          <h4>Esta pasta</h4>
          <dl>
            <dt>Motor</dt><dd>IronCalc {IRONCALC_VERSION} (WASM), em segundo plano</dd>
            <dt>Fórmulas</dt><dd>Português (Brasil); separadores do locale “{ENGINE_LOCALE}” do motor</dd>
            <dt>Memória do motor</dt><dd>{mib(stats?.wasmMemoryBytes ?? null)}</dd>
            <dt>Arquivo</dt><dd>{FORMAT_DESCRIPTION}</dd>
            <dt>Dados</dt><dd>Ficam neste dispositivo. Nada é enviado.</dd>
          </dl>
        </div>
      )}
    </span>
  );
}
