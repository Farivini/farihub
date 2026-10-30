import { Icon } from './ui/Icon.tsx';

/** Spaces planned in the product that have no editor yet. Deliberately not a mock editor. */
export function Placeholder({ space }: { space: 'fardoc' | 'farcanvas' }) {
  const copy = space === 'fardoc'
    ? { title: 'Documentos', text: 'Relatórios e textos com tabelas e números vindos das suas planilhas.' }
    : { title: 'Apresentações', text: 'Slides com gráficos e tabelas ligados às suas planilhas.' };
  return (
    <div className={`placeholder ${space}`} data-testid="placeholder">
      <div className="placeholder-mark"><Icon name={space} size={30} /></div>
      <h2>{copy.title}</h2>
      <p>{copy.text}</p>
      <span className="pill">Em preparação</span>
      <p className="placeholder-note">Suas planilhas abertas continuam como estavam em Planilhas.</p>
    </div>
  );
}
