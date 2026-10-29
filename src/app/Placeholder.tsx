import { Icon } from './ui/Icon.tsx';

/** Spaces that exist in the product plan but have no editor yet. Deliberately not a mock editor. */
export function Placeholder({ space }: { space: 'fardoc' | 'farcanvas' }) {
  const copy = space === 'fardoc'
    ? { title: 'Fardoc', text: 'Documentos com texto rico, tabelas e trechos vindos do Farcel.' }
    : { title: 'Farcanvas', text: 'Apresentações e composição visual com gráficos e tabelas do Farcel.' };
  return (
    <div className={`placeholder ${space}`}>
      <div className="placeholder-mark"><Icon name={space} size={30} /></div>
      <h2>{copy.title}</h2>
      <p>{copy.text}</p>
      <span className="pill">Em preparação</span>
    </div>
  );
}
