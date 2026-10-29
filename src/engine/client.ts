import type { EngineApi, EngineEvent, RequestType, Response } from './protocol.ts';

/** Main-thread handle to the engine worker. Every call is asynchronous; the UI never blocks on the engine. */
export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(event: EngineEvent) => void>();

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (message: MessageEvent<Response | EngineEvent>) => {
      const data = message.data;
      if ('event' in data) { this.listeners.forEach(listener => listener(data)); return; }
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.ok) entry.resolve(data.result);
      else entry.reject(new Error(data.error));
    };
    this.worker.onerror = event => {
      const error = new Error(`Falha no motor: ${event.message}`);
      this.pending.forEach(entry => entry.reject(error));
      this.pending.clear();
    };
  }

  call<T extends RequestType>(type: T, ...payload: EngineApi[T][0] extends void ? [] : [EngineApi[T][0]]): Promise<EngineApi[T][1]> {
    const id = this.nextId++;
    const body = payload[0];
    const transfer = body && typeof body === 'object' && 'bytes' in body && body.bytes instanceof Uint8Array ? [body.bytes.buffer as ArrayBuffer] : [];
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, type, payload: body }, transfer);
    });
  }

  on(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
