/**
 * Farcel workbook file (.farcel). This is NOT XLSX.
 *
 * Layout (little endian):
 *   8 bytes  magic "FARCEL01"
 *   4 bytes  header length H
 *   H bytes  UTF-8 JSON header (FarcelHeader)
 *   N bytes  payload: IronCalc Model.toBytes() of the engine version named in the header
 */

export const MAGIC = 'FARCEL01';
export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = '.farcel';
export const FORMAT_DESCRIPTION = 'Pasta de trabalho Farcel (.farcel): formato próprio com o estado interno do IronCalc e metadados JSON. Não é XLSX.';

export interface FarcelHeader {
  format: 'farcel';
  formatVersion: number;
  savedAt: string;
  engine: { name: 'IronCalc'; package: '@ironcalc/wasm'; version: string; payload: 'Model.toBytes' };
  payloadBytes: number;
  payloadCrc32: number;
  /** Application state that is not part of the engine model (pivot and chart configuration). */
  app: Record<string, unknown>;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFarcel(payload: Uint8Array, engineVersion: string, app: Record<string, unknown>, savedAt = new Date()): Uint8Array {
  const header: FarcelHeader = {
    format: 'farcel', formatVersion: FORMAT_VERSION, savedAt: savedAt.toISOString(),
    engine: { name: 'IronCalc', package: '@ironcalc/wasm', version: engineVersion, payload: 'Model.toBytes' },
    payloadBytes: payload.length, payloadCrc32: crc32(payload), app,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + 4 + headerBytes.length + payload.length);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(payload, 12 + headerBytes.length);
  return out;
}

export class FarcelFormatError extends Error {}

export function decodeFarcel(file: Uint8Array): { header: FarcelHeader; payload: Uint8Array } {
  if (file.length < 12 || new TextDecoder().decode(file.subarray(0, 8)) !== MAGIC) {
    throw new FarcelFormatError('Arquivo não é uma pasta de trabalho Farcel (.farcel).');
  }
  const headerLength = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(8, true);
  if (12 + headerLength > file.length) throw new FarcelFormatError('Arquivo Farcel truncado (cabeçalho incompleto).');
  let header: FarcelHeader;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.subarray(12, 12 + headerLength)));
  } catch {
    throw new FarcelFormatError('Cabeçalho do arquivo Farcel ilegível.');
  }
  if (header.format !== 'farcel' || header.formatVersion !== FORMAT_VERSION) {
    throw new FarcelFormatError(`Versão de formato Farcel não suportada: ${header.formatVersion}`);
  }
  const payload = file.subarray(12 + headerLength);
  if (payload.length !== header.payloadBytes) throw new FarcelFormatError('Arquivo Farcel truncado (dados incompletos).');
  if (crc32(payload) !== header.payloadCrc32) throw new FarcelFormatError('Arquivo Farcel corrompido (CRC32 não confere).');
  return { header, payload };
}
