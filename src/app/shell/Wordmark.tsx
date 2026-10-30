import { useId } from 'react';

/**
 * Fariv signature: wide-tracked thin capitals with the open A (no crossbar) in Fariv orange.
 * Vector redraw for the interface, on a transparent background. The same geometry is in
 * src/app/assets/fariv-assinatura.svg for use outside React.
 */
export const WORDMARK_LETTERS = {
  F: 'M2 22V2h12M2 12h10',
  A: 'M32 22L40 2l8 20',
  R: 'M66 22V2h8.5a5 5 0 0 1 0 10H66M74 12l7 10',
  I: 'M99 2v20',
  V: 'M116 2l8 20 8-20',
} as const;
const WIDTH = 134;

export function Wordmark({ height = 18, title = 'Fariv' }: { height?: number; title?: string }) {
  const gradient = useId();
  const width = (height * WIDTH) / 24;
  return (
    <svg className="wordmark" width={width} height={height} viewBox={`0 0 ${WIDTH} 24`} role="img" aria-label={title}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--orange-deep, #e4561a)" />
          <stop offset="1" stopColor="var(--orange-bright, #ff9a52)" />
        </linearGradient>
      </defs>
      <g fill="none" strokeWidth="2.2" strokeLinejoin="miter" strokeLinecap="butt">
        <path d={WORDMARK_LETTERS.F} stroke="currentColor" />
        <path d={WORDMARK_LETTERS.A} stroke={`url(#${gradient})`} />
        <path d={WORDMARK_LETTERS.R} stroke="currentColor" />
        <path d={WORDMARK_LETTERS.I} stroke="currentColor" />
        <path d={WORDMARK_LETTERS.V} stroke="currentColor" />
      </g>
    </svg>
  );
}

/** The open A alone, for compact places (favicon, collapsed brand). */
export function FarivGlyph({ size = 18 }: { size?: number }) {
  const gradient = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#e4561a" />
          <stop offset="1" stopColor="#ff9a52" />
        </linearGradient>
      </defs>
      <path d="M4 21L12 3l8 18" fill="none" stroke={`url(#${gradient})`} strokeWidth="2.6" />
    </svg>
  );
}
