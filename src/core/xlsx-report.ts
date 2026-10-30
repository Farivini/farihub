/**
 * What an imported .xlsx held, as reported by the converter (native/xlsx-bridge): features
 * that are not kept, features kept and exported again but not shown by Planilhas yet, and
 * counts. Codes come from the bridge; labels are for the person.
 */

export interface XlsxReport {
  /** Not imported by IronCalc 0.9.1, or imported but not written back on export. */
  lost: Record<string, number>;
  /** In the engine and in an exported .xlsx, but not displayed by the Planilhas grid. */
  kept: Record<string, number>;
  cells: number;
  formulas: number;
  sheets: number;
}

const LOST: Record<string, string> = {
  charts: 'gráficos',
  chartSheets: 'abas de gráfico',
  images: 'imagens',
  drawings: 'desenhos e objetos',
  pivotTables: 'tabelas dinâmicas do Excel',
  macros: 'macros (VBA)',
  externalLinks: 'vínculos com outras pastas',
  tables: 'tabelas formatadas (a estrutura; os dados ficam)',
  comments: 'comentários',
  slicers: 'segmentações de dados',
  connections: 'conexões de dados e consultas',
  controls: 'controles de formulário',
  dataValidation: 'validação de dados',
  autoFilter: 'filtros aplicados (a definição; as linhas que ocultavam continuam ocultas)',
  protection: 'proteção de planilha ou pasta',
  sparklines: 'minigráficos',
  printSettings: 'configuração de impressão',
  richText: 'formatação de parte do texto de uma célula (o texto fica)',
};

const KEPT: Record<string, string> = {
  mergedCells: 'células mescladas',
  frozenPanes: 'painéis congelados',
  columnWidths: 'larguras de coluna',
  rowHeights: 'alturas de linha',
  hiddenColumns: 'colunas ocultas',
  // Reports saved before hidden rows were shown by the grid.
  hiddenRowsColumns: 'linhas ou colunas ocultas',
  conditionalFormatting: 'formatação condicional',
  hyperlinks: 'hiperlinks',
  hiddenSheets: 'planilhas ocultas',
  gridlinesHidden: 'linhas de grade ocultas',
  definedNames: 'nomes definidos',
  fontStyles: 'fontes, tamanhos e cores de texto',
  fills: 'cores de preenchimento',
  borders: 'bordas',
  wrapVertical: 'quebra de texto e alinhamento vertical',
};

const label = (labels: Record<string, string>, code: string) => labels[code] ?? code;

export const lostFeatures = (report: XlsxReport) => Object.keys(report.lost).map(code => label(LOST, code));
export const keptFeatures = (report: XlsxReport) => Object.keys(report.kept).map(code => label(KEPT, code));

export function parseReport(json: string): XlsxReport {
  const value = JSON.parse(json) as Partial<XlsxReport>;
  return { lost: value.lost ?? {}, kept: value.kept ?? {}, cells: value.cells ?? 0, formulas: value.formulas ?? 0, sheets: value.sheets ?? 0 };
}
