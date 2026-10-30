import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect(): void;
}

/**
 * Button that opens a list of actions. Keyboard: Enter/Space/ArrowDown open, arrows move,
 * Escape closes and returns focus to the button.
 */
export function MenuButton({ label, items, children, className, align = 'start', placement = 'below', testId, disabled }: {
  label: string; items: MenuItem[]; children: ReactNode; className?: string;
  align?: 'start' | 'end'; placement?: 'below' | 'above' | 'right'; testId?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!list.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  useLayoutEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not([disabled]),[role=menuitemradio]:not([disabled])')?.focus();
  }, [open]);

  const onListKey = (event: React.KeyboardEvent) => {
    const entries = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
  };

  return (
    <span className="menu-anchor">
      <button
        ref={button}
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-testid={testId}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}
      >{children}</button>
      {open && (
        <div ref={list} className={`menu ${align} ${placement}`} role="menu" aria-label={label} onKeyDown={onListKey}>
          {items.map(item => (
            <div key={item.id} role="none">
              {item.separatorBefore && <div className="menu-separator" role="separator" />}
              <button
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                disabled={item.disabled}
                className="menu-item"
                onClick={() => { close(false); item.onSelect(); }}
              >
                <span className="menu-icon">{item.checked ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6.5 12.5l3.5 3.5 7.5-8" /></svg> : item.icon}</span>
                <span className="menu-label">{item.label}</span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
