/** Stroke icons drawn on a 24px grid, 1.6px lines. One family for the whole interface. */
const paths: Record<string, string> = {
  files: 'M8 3.5h6.5l4.5 4.5v11.5A1.5 1.5 0 0 1 17.5 21h-9A1.5 1.5 0 0 1 7 19.5V5A1.5 1.5 0 0 1 8.5 3.5zM14 3.5V8.5h5',
  farcel: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 9.5h16M4 14.5h16M9.5 9.5V20',
  fardoc: 'M7 3.5h7l4.5 4.5v12A1.5 1.5 0 0 1 17 21.5H7A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5zM13.5 3.5V8.5h5M8.5 12.5h7M8.5 16h5',
  farcanvas: 'M3.5 6A1.5 1.5 0 0 1 5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15zM12 16.5v3.5M8 20h8',
  sparkle: 'M12 2.5c.6 4.6 2.9 6.9 7.5 7.5-4.6.6-6.9 2.9-7.5 7.5-.6-4.6-2.9-6.9-7.5-7.5 4.6-.6 6.9-2.9 7.5-7.5z',
  open: 'M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z',
  save: 'M5 4.5h11.5l3 3V19A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A.5.5 0 0 1 5 4.5zM8 4.5v4.5h7V4.5M7.5 20.5v-6h9v6',
  undo: 'M9 7.5L5 11.5l4 4M5.5 11.5H15a4 4 0 0 1 0 8h-2',
  redo: 'M15 7.5l4 4-4 4M18.5 11.5H9a4 4 0 0 0 0 8h2',
  pivot: 'M4.5 4.5h15v15h-15zM4.5 9h15M9 4.5v15M13 13h4M13 16h4',
  base: 'M12 4c4.4 0 7.5 1.3 7.5 2.75S16.4 9.5 12 9.5 4.5 8.2 4.5 6.75 7.6 4 12 4zM4.5 6.75v10.5C4.5 18.7 7.6 20 12 20s7.5-1.3 7.5-2.75V6.75M4.5 12c0 1.45 3.1 2.75 7.5 2.75s7.5-1.3 7.5-2.75',
  plus: 'M12 5.5v13M5.5 12h13',
  close: 'M7 7l10 10M17 7L7 17',
  filter: 'M5 6h14l-5.5 6.5V18l-3 1.5v-7z',
  chevron: 'M9 6l6 6-6 6',
  'chevron-down': 'M7 10l5 5 5-5',
  bold: 'M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12h6.5a3.5 3.5 0 0 1 0 7H7.5z',
  'align-left': 'M4.5 6h15M4.5 10h10M4.5 14h15M4.5 18h10',
  'align-center': 'M4.5 6h15M7 10h10M4.5 14h15M7 18h10',
  'align-right': 'M4.5 6h15M9.5 10h10M4.5 14h15M9.5 18h10',
  menu: 'M4.5 7h15M4.5 12h15M4.5 17h15',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7.4 7.4 0 0 1-2 1.2L15 20.5h-3.6l-.3-2.2a7.4 7.4 0 0 1-2-1.2l-1.9.7-1.8-3.1 1.6-1.2a7.6 7.6 0 0 1 0-2.4L5.4 9.9l1.8-3.1 1.9.7a7.4 7.4 0 0 1 2-1.2l.3-2.2H15l.3 2.2a7.4 7.4 0 0 1 2 1.2l1.9-.7 1.8 3.1-1.6 1.2a7.6 7.6 0 0 1 0 2.4z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  check: 'M6.5 12.5l3.5 3.5 7.5-8',
  send: 'M12 19V5.5M6.5 11l5.5-5.5 5.5 5.5',
  function: 'M14.5 4.5c-2 0-3 1-3.4 3L9.5 17c-.4 2-1.4 2.5-3 2.5M8 9.5h7M14 12l4.5 5M18.5 12L14 17',
  'panel-right': 'M4.5 5.5h15v13h-15zM14.5 5.5v13',
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18, strokeWidth = 1.6 }: { name: IconName | string; size?: number; strokeWidth?: number }) {
  const dots = name === 'more';
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={dots ? 2.6 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/** File-type badges used in document tabs and context chips. */
export function FileBadge({ kind, size = 16 }: { kind: 'sheet' | 'doc' | 'slides'; size?: number }) {
  const color = kind === 'sheet' ? 'var(--file-sheet)' : kind === 'doc' ? 'var(--file-doc)' : 'var(--file-slides)';
  return (
    <svg className="file-badge" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill={color} />
      {kind === 'sheet' && <path d="M5 7.5h6M5 10h6M5 12.5h6M8 7.5v5" stroke="rgba(0,0,0,.55)" strokeWidth="1" fill="none" />}
      {kind === 'doc' && <path d="M5 8h6M5 10.5h6M5 13h4" stroke="rgba(0,0,0,.55)" strokeWidth="1" fill="none" />}
      {kind === 'slides' && <path d="M5 8h6v4.5H5z" stroke="rgba(0,0,0,.55)" strokeWidth="1" fill="none" />}
    </svg>
  );
}
