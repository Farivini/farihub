import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFarcel, decodeFarcel, crc32, FarcelFormatError } from '../src/core/file-format.ts';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('container round-trips and rejects foreign, truncated and corrupted files', () => {
  const payload = new Uint8Array([1, 2, 3, 250]);
  const file = encodeFarcel(payload, '0.9.1', { pivots: [{ rows: ['Região'] }] }, new Date('2026-10-29T00:00:00Z'));
  const { header, payload: back } = decodeFarcel(file);
  assert.deepEqual([...back], [...payload]);
  assert.equal(header.engine.version, '0.9.1');
  assert.deepEqual(header.app, { pivots: [{ rows: ['Região'] }] });
  assert.throws(() => decodeFarcel(new TextEncoder().encode('PK\u0003\u0004 xlsx')), FarcelFormatError);
  assert.throws(() => decodeFarcel(file.subarray(0, file.length - 1)), /truncado/);
  const corrupted = file.slice();
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => decodeFarcel(corrupted), /CRC32/);
});
