/**
 * Interoperability files for checking exported .xlsx in another spreadsheet application.
 *
 *   node scripts/xlsx-interop.ts            -> reports/interop/*.xlsx
 *   python3 scripts/xlsx-interop-libreoffice.py reports/interop/*.xlsx
 *
 * Writes (1) a workbook typed in pt-BR with common functions, formats and two sheets, (2) a
 * 5 000-row synthetic base with its summary sheet, and (3) every fixture in tests/fixtures/xlsx
 * after import -> edit -> export. The LibreOffice script recalculates each file there and
 * compares every formula result with the value Farcel wrote. Excel itself is not available
 * in this environment; see docs/xlsx.md.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { modelToXlsx, xlsxToModel } from '../src/engine/xlsx.ts';
import { ic } from '../tests/ironcalc-node.ts';
import { xlsxBridge } from '../tests/xlsx-node.ts';

const out = new URL('../reports/interop/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name: string, engine: WorkbookEngine) => {
  const bytes = modelToXlsx(xlsxBridge, engine.modelBytes());
  writeFileSync(new URL(name, out), bytes);
  console.log(name, bytes.length, 'bytes');
};

// 1. Functions and formats typed as a Brazilian user would.
const typed = WorkbookEngine.create(ic, 'Funções');
const data = [
  ['Produto', 'Região', 'Qtd', 'Preço', 'Data'],
  ['Caneta', 'Sul', '10', '2,5', '05/01/2024'],
  ['Caderno', 'Norte', '3', '15,9', '20/02/2024'],
  ['Lápis', 'Sul', '25', '0,75', '31/03/2024'],
  ['Borracha', 'Sudeste', '7', '1,2', '15/04/2024'],
];
data.forEach((row, r) => row.forEach((value, c) => typed.setInput(0, r + 1, c + 1, value)));
const formulas = [
  '=SOMA(C2:C5)', '=MÉDIA(D2:D5)', '=MÁXIMO(C2:C5)-MÍNIMO(C2:C5)', '=ARRED(D3*1,1;2)',
  '=SE(C2>5;"muito";"pouco")', '=E(C2>5;D2<3)', '=OU(C3>5;D3<3)', '=SEERRO(1/0;"erro tratado")',
  '=PROCV("Lápis";A2:D5;4;FALSO)', '=ÍNDICE(A2:A5;CORRESP("Caderno";A2:A5;0))', '=SOMASE(B2:B5;"Sul";C2:C5)',
  '=CONT.SE(B2:B5;"Sul")', '=CONT.VALORES(A2:A5)', '=CONT.NÚM(C2:D5)', '=SOMARPRODUTO(C2:C5;D2:D5)',
  '=CONCATENAR(A2;" - ";B2)', '=A3&" ("&B3&")"', '=MAIÚSCULA(A4)', '=ESQUERDA(A5;3)', '=NÚM.CARACT(A2)',
  '=ANO(E2)', '=MÊS(E3)', '=DIA(E4)', '=DATA(2024;12;25)-E2', '=ABS(-3,5)', '=POTÊNCIA(2;10)', '=RAIZ(81)',
  '=$C$2*C3', '=Planilha2!B1*2', '=1/0', '=MÉDIASE(B2:B5;"Sul";D2:D5)', '=TRUNCAR(10/3;2)',
];
formulas.forEach((formula, i) => {
  typed.setInput(0, i + 1, 7, `Fórmula ${i + 1}`);
  typed.setInput(0, i + 1, 8, formula);
});
typed.format(0, { top: 1, left: 1, bottom: 1, right: 5 }, { kind: 'bold', value: true });
typed.format(0, { top: 1, left: 1, bottom: 1, right: 5 }, { kind: 'align', value: 'center' });
typed.format(0, { top: 2, left: 4, bottom: 5, right: 4 }, { kind: 'number', value: 'currency' });
typed.format(0, { top: 2, left: 5, bottom: 5, right: 5 }, { kind: 'number', value: 'date' });
typed.format(0, { top: 4, left: 8, bottom: 4, right: 8 }, { kind: 'number', value: 'number' });
typed.addSheet();
typed.setInput(1, 1, 1, 'Total');
typed.setInput(1, 1, 2, '=SOMA(Planilha1!C2:C5)');
typed.setInput(1, 2, 1, 'Participação Sul');
typed.setInput(1, 2, 2, '=SOMASE(Planilha1!B2:B5;"Sul";Planilha1!C2:C5)/B1');
typed.format(1, { top: 2, left: 2, bottom: 2, right: 2 }, { kind: 'number', value: 'percent' });
write('farcel-funcoes.xlsx', typed);

// 2. Synthetic base: the same generator as the 1M-row benchmark, smaller.
const { engine: synthetic } = await WorkbookEngine.generateSynthetic(ic, 5_000, 20261029);
write('farcel-base-5000.xlsx', synthetic);

// 3. Fixtures after import -> edit -> export.
const fixtures = new URL('../tests/fixtures/xlsx/', import.meta.url);
for (const name of readdirSync(fixtures).filter(n => n.endsWith('.xlsx'))) {
  const { model } = xlsxToModel(xlsxBridge, new Uint8Array(readFileSync(new URL(name, fixtures))), name.replace(/\.xlsx$/, ''));
  const { engine } = WorkbookEngine.fromModelBytes(ic, model);
  engine.setInput(0, 30, 1, 'Editado no Farcel');
  engine.setInput(0, 30, 2, '=CONT.VALORES(A1:A10)');
  write(`ida-e-volta-${name}`, engine);
}
