import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplayInput, toEngineInput, tokenize, localizeValue, FUNCTION_NAMES } from '../src/core/formula-locale.ts';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { ic } from './ironcalc-node.ts';

test('function names are translated only where they are calls', () => {
  assert.equal(toEngineInput('=SOMA(A1:A3)'), '=SUM(A1:A3)');
  assert.equal(toEngineInput('=soma(a1:a3)'), '=SUM(a1:a3)');
  assert.equal(toEngineInput('=SE(A1>0;"SOMA(A1)";\'SOMA\'!A1)'), '=IF(A1>0;"SOMA(A1)";\'SOMA\'!A1)');
  assert.equal(toEngineInput('=SOMA!A1+SE1'), '=SOMA!A1+SE1', 'sheet named SOMA and cell SE1 stay intact');
  assert.equal(toEngineInput('=CONT.SE(A:A;">1,5")'), '=COUNTIF(A:A;">1,5")');
  assert.equal(toEngineInput('=MÉDIA(1,5;2)'), '=AVERAGE(1,5;2)');
  assert.equal(toEngineInput('=MEDIA(1;2)'), '=AVERAGE(1;2)', 'unaccented spelling accepted on input');
  assert.equal(toEngineInput('=É.NÃO.DISP(PROCV(1;A:B;2;FALSO))'), '=ISNA(VLOOKUP(1;A:B;2;FALSE))');
  assert.equal(toEngineInput('=Tabela1[Receita]'), '=Tabela1[Receita]');
  assert.equal(toEngineInput('=SOMA({1;2})'), '=SUM({1;2})');
  assert.equal(toEngineInput('=SE(A1=#N/D;0;1)'), '=IF(A1=#N/A;0;1)');
  assert.equal(toEngineInput('=1E+3*SOMA(1)'), '=1E+3*SUM(1)');
  assert.equal(toEngineInput('=FUNCAODESCONHECIDA(1)'), '=FUNCAODESCONHECIDA(1)');
  assert.equal(toEngineInput('verdadeiro'), 'TRUE');
  assert.equal(toEngineInput('SOMA(A1)'), 'SOMA(A1)', 'plain text is not a formula');
  assert.equal(toEngineInput('ação'), 'ação');
});

test('display direction is the inverse for every mapped function', () => {
  for (const [en, pt] of FUNCTION_NAMES) {
    assert.equal(toDisplayInput(`=${en}(1)`), `=${pt}(1)`);
    assert.equal(toEngineInput(`=${pt}(1)`), `=${en}(1)`);
  }
  assert.equal(toDisplayInput('=IF(A1;"IF(";TRUE)'), '=SE(A1;"IF(";VERDADEIRO)');
  assert.equal(localizeValue('#VALUE!', 'error'), '#VALOR!');
  assert.equal(localizeValue('FALSE', 'boolean'), 'FALSO');
});

test('tokenizer keeps strings with doubled quotes and unterminated text intact', () => {
  const tokens = tokenize('SE(A1;"diz ""SOMA(1)""";"')
  assert.deepEqual(tokens.filter(t => t.kind === 'string').map(t => t.text), ['"diz ""SOMA(1)"""', '"']);
  assert.equal(tokens.map(t => t.text).join(''), 'SE(A1;"diz ""SOMA(1)""";"');
});

test('every mapped function is known to IronCalc 0.9.1 (no #NAME?)', () => {
  const engine = WorkbookEngine.create(ic);
  FUNCTION_NAMES.forEach(([, pt], i) => engine.setInput(0, i + 1, 1, `=${pt}()`));
  const unknown = FUNCTION_NAMES.filter((_, i) => engine.formatted(0, i + 1, 1) === '#NOME?').map(([en]) => en);
  assert.deepEqual(unknown, []);
});

test('pt-BR formulas evaluate in the engine with comma decimals and semicolons', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, '100');
  engine.setInput(0, 2, 1, '200,5');
  engine.setInput(0, 3, 1, '1.234,5');
  const cases: Array<[string, string]> = [
    ['=SOMA(A1:A3)', '1535'],
    ['=MÉDIA(A1:A2)', '150,25'],
    ['=SE(A1>50;"sim";"não")', 'sim'],
    ['=SOMASE(A1:A3;">150")', '1435'],
    ['=CONT.SE(A1:A3;">150")', '2'],
    ['=ARRED(2,345;2)', '2,35'],
    ['=PROCV(200,5;A1:A3;1;FALSO)', '200,5'],
    ['=SEERRO(1/0;"erro")', 'erro'],
    ['=1/0', '#DIV/0!'],
    ['=MÁXIMO(A1:A3)', '1234,5'],
    ['=É.NÃO.DISP(PROCV(9;A1:A3;1;FALSO))', 'VERDADEIRO'],
    ['=CONCATENAR("ação";" ";"é")', 'ação é'],
    ['=NÃOEXISTE(1)', '#NOME?'],
  ];
  cases.forEach(([formula], i) => engine.setInput(0, i + 1, 3, formula));
  const actual = cases.map((_, i) => engine.formatted(0, i + 1, 3));
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
  assert.equal(engine.input(0, 1, 3), '=SOMA(A1:A3)');
  assert.equal(engine.input(0, 3, 3), '=SE(A1>50;"sim";"não")');
  assert.equal(engine.rawContent(0, 3, 3), '=IF(A1>50;"sim";"não")');
});
