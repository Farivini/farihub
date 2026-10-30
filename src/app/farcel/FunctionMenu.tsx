import { useEffect, useRef, useState } from 'react';
import { FUNCTION_NAMES } from '../../core/formula-locale.ts';

/** Functions offered first; the search covers every mapped function. */
const COMMON = ['SOMA', 'MÉDIA', 'SE', 'PROCV', 'PROCX', 'SOMASE', 'SOMASES', 'CONT.SE', 'CONT.VALORES', 'MÁXIMO', 'MÍNIMO', 'ARRED', 'SEERRO', 'HOJE'];
const ALL = FUNCTION_NAMES.map(([, pt]) => pt).filter((name, i, list) => list.indexOf(name) === i).sort((a, b) => a.localeCompare(b, 'pt-BR'));
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** "fx" button: inserts a function name (pt-BR) into the formula being edited. */
export function FunctionMenu({ onPick, disabled }: { onPick(name: string): void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const shown = query ? ALL.filter(name => plain(name).includes(plain(query))) : COMMON;
  const pick = (name: string) => { setOpen(false); setQuery(''); onPick(name); };
  return (
    <span className="menu-anchor">
      <button ref={button} className="fx-button" aria-label="Inserir função" title="Inserir função" aria-haspopup="dialog" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen(o => !o)} data-testid="function-menu"><i>fx</i></button>
      {open && (
        <div ref={box} className="menu function-menu below start" role="dialog" aria-label="Inserir função"
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } }}>
          <input autoFocus className="menu-search" placeholder="Buscar função" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0]); } }} aria-label="Buscar função" />
          <div className="menu-caption">{query ? `${shown.length} de ${ALL.length} funções` : 'Mais usadas'}</div>
          <div className="function-list">
            {shown.slice(0, 60).map(name => (
              <button key={name} className="menu-item" onClick={() => pick(name)}><span className="menu-label mono">{name}</span></button>
            ))}
            {shown.length === 0 && <p className="menu-empty">Nenhuma função com esse nome.</p>}
          </div>
        </div>
      )}
    </span>
  );
}
