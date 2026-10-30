/// <reference lib="webworker" />
import init, * as bridge from '../../vendor/xlsx-bridge/xlsx_bridge.js';
import wasmUrl from '../../vendor/xlsx-bridge/xlsx_bridge_bg.wasm?url';
import { modelToXlsx, xlsxToModel } from './xlsx.ts';
import type { XlsxRequest, XlsxResponse } from './xlsx-client.ts';

declare const self: DedicatedWorkerGlobalScope;

/** One conversion per worker: the caller terminates it afterwards, freeing its memory. */
self.onmessage = async (message: MessageEvent<XlsxRequest>) => {
  const request = message.data;
  let response: XlsxResponse;
  try {
    await init({ module_or_path: wasmUrl });
    const started = performance.now();
    response = request.kind === 'import'
      ? { ok: true, ...xlsxToModel(bridge, request.bytes, request.name), ms: performance.now() - started }
      : { ok: true, xlsx: modelToXlsx(bridge, request.model), ms: performance.now() - started };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const bytes = response.ok ? ('model' in response ? response.model : response.xlsx) : null;
  self.postMessage(response, bytes ? [bytes.buffer as ArrayBuffer] : []);
};
