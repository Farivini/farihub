const paths: Record<string, string> = {
  farcel: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 9.5h16M4 14.5h16M9.5 9.5V20',
  fardoc: 'M7 3.5h7l4.5 4.5v12A1.5 1.5 0 0 1 17 21.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5zM13.5 3.5V8.5h5M8.5 12.5h7M8.5 16h5',
  farcanvas: 'M3.5 6A1.5 1.5 0 0 1 5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15zM12 16.5v3.5M8 20h8M7.5 12.5l3-3 2.5 2.5 3.5-4',
  sparkle: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  open: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z',
  save: 'M5 4.5h11.5l3 3V19A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A.5.5 0 0 1 5 4.5zM8 4.5v4.5h7V4.5M7.5 20.5v-6h9v6',
  undo: 'M9 7.5L5 11.5l4 4M5.5 11.5H15a4 4 0 0 1 0 8h-2',
  redo: 'M15 7.5l4 4-4 4M18.5 11.5H9a4 4 0 0 0 0 8h2',
  pivot: 'M4.5 4.5h15v15h-15zM4.5 9h15M9 4.5v15M13 13h4M13 16h4M15 11v2',
  chart: 'M4.5 19.5h15M7.5 16.5v-5M12 16.5v-9M16.5 16.5v-7',
  base: 'M12 4c4.4 0 7.5 1.3 7.5 2.75S16.4 9.5 12 9.5 4.5 8.2 4.5 6.75 7.6 4 12 4zM4.5 6.75v10.5C4.5 18.7 7.6 20 12 20s7.5-1.3 7.5-2.75V6.75M4.5 12c0 1.45 3.1 2.75 7.5 2.75s7.5-1.3 7.5-2.75',
  plus: 'M12 5.5v13M5.5 12h13',
  close: 'M7 7l10 10M17 7L7 17',
  panel: 'M4.5 5.5h15v13h-15zM14.5 5.5v13',
  filter: 'M5 6h14l-5.5 6.5V18l-3 1.5v-7z',
  chevron: 'M9 6l6 6-6 6',
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/** Fariv mark: three stacked planes, one per space. */
export function FarivMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="fariv-a" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dd3c0" />
          <stop offset="0.55" stopColor="#6b8cff" />
          <stop offset="1" stopColor="#b18cff" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="26" height="26" rx="8" fill="url(#fariv-a)" />
      <path d="M11 22V10h10M11 16h7" stroke="#0b0d12" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
