import type { XlsxReport } from '../core/xlsx-report.ts';

export type XlsxRequest = { kind: 'import'; bytes: Uint8Array; name: string } | { kind: 'export'; model: Uint8Array };
export type XlsxResponse =
  | { ok: true; model: Uint8Array; report: XlsxReport; ms: number }
  | { ok: true; xlsx: Uint8Array; ms: number }
  | { ok: false; error: string };

/**
 * Runs one conversion in its own worker, loaded only when an .xlsx is opened or exported and
 * terminated afterwards. A failure in the converter cannot affect the engine of any tab.
 */
function run(request: XlsxRequest, transfer: ArrayBuffer): Promise<Extract<XlsxResponse, { ok: true }>> {
  const worker = new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Extract<XlsxResponse, { ok: true }>>((resolve, reject) => {
    worker.onmessage = (message: MessageEvent<XlsxResponse>) => {
      const data = message.data;
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = event => reject(new Error(`Falha no conversor XLSX: ${event.message}`));
    worker.postMessage(request, [transfer]);
  }).finally(() => worker.terminate());
}

export async function importXlsx(bytes: Uint8Array, name: string): Promise<{ model: Uint8Array; report: XlsxReport; ms: number }> {
  const result = await run({ kind: 'import', bytes, name }, bytes.buffer as ArrayBuffer);
  if (!('model' in result)) throw new Error('Resposta inesperada do conversor XLSX');
  return result;
}

export async function exportXlsx(model: Uint8Array): Promise<{ xlsx: Uint8Array; ms: number }> {
  const result = await run({ kind: 'export', model }, model.buffer as ArrayBuffer);
  if (!('xlsx' in result)) throw new Error('Resposta inesperada do conversor XLSX');
  return result;
}
