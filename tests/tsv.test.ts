import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsv, serializeTsv } from '../src/core/tsv.ts';

test('Excel clipboard text round-trips with tabs, line breaks, quotes and accents', () => {
  const rows = [['ação', 'a\tb', 'linha1\nlinha2'], ['1,5', '=A2*2', 'diz "oi"'], ['', 'Ç', '']];
  const text = serializeTsv(rows);
  assert.equal(text, 'ação\t"a\tb"\t"linha1\nlinha2"\n1,5\t=A2*2\t"diz ""oi"""\n\tÇ\t');
  assert.deepEqual(parseTsv(text), rows);
  assert.deepEqual(parseTsv(text + '\r\n'), rows, 'one trailing line break is not an extra row');
});

test('ragged rows are padded and stray quotes are kept as text', () => {
  assert.deepEqual(parseTsv('a\tb\nc'), [['a', 'b'], ['c', '']]);
  assert.deepEqual(parseTsv('5" tela\tx'), [['5" tela', 'x']]);
  assert.deepEqual(parseTsv('"abc"d\te'), [['"abc"d', 'e']]);
  assert.deepEqual(parseTsv(''), [['']]);
});
