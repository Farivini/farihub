import { inflateRawSync } from 'node:zlib';

/** Minimal ZIP reader for tests: the parts of an .xlsx package by name (stored or deflated). */
export function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const parts = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true);
    const comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    parts.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data));
    offset += 46 + nameLength + extra + comment;
  }
  return parts;
}
