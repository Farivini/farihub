import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Modal dialog drawn by the app (window.confirm is unavailable in some hosts). */
export function Dialog({ title, children, onClose, actions, testId }: {
  title: string; children: ReactNode; onClose(): void; actions: ReactNode; testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input, button.primary, button')?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}
        onMouseDown={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        <h3>{title}</h3>
        {children}
        <footer>{actions}</footer>
      </div>
    </div>
  );
}
