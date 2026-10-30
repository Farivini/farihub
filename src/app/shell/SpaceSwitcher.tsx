export type Space = 'farcel' | 'fardoc' | 'farcanvas';
/** Internal ids stay farcel/fardoc/farcanvas; these are the visible names. */
export const SPACES: Array<{ id: Space; label: string; short: string }> = [
  { id: 'farcel', label: 'Planilhas', short: 'Planilhas' },
  { id: 'fardoc', label: 'Documentos', short: 'Docs' },
  { id: 'farcanvas', label: 'Apresentações', short: 'Slides' },
];

export function SpaceSwitcher({ space, onChange }: { space: Space; onChange(space: Space): void }) {
  const move = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = SPACES[(index + delta + SPACES.length) % SPACES.length];
    onChange(next.id);
    (event.currentTarget.parentElement?.querySelector(`[data-space="${next.id}"]`) as HTMLButtonElement | null)?.focus();
  };
  return (
    <div className="space-switcher" role="tablist" aria-label="Espaços">
      {SPACES.map((s, i) => (
        <button
          key={s.id}
          role="tab"
          data-space={s.id}
          data-testid={`space-${s.id}`}
          aria-selected={space === s.id}
          tabIndex={space === s.id ? 0 : -1}
          className={space === s.id ? 'space active' : 'space'}
          onClick={() => onChange(s.id)}
          onKeyDown={e => move(e, i)}
        >
          <span className="space-label">{s.label}</span>
          <span className="space-short" aria-hidden="true">{s.short}</span>
        </button>
      ))}
    </div>
  );
}
