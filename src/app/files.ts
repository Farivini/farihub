import { FILE_EXTENSION } from '../core/file-format.ts';

export interface FileKind { description: string; mime: string; extension: string }

export const FILE_KINDS = {
  farcel: { description: 'Pasta de trabalho Fariv', mime: 'application/x-farcel', extension: FILE_EXTENSION },
  xlsx: { description: 'Pasta de trabalho do Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
  csv: { description: 'Texto separado por ponto e vírgula (CSV)', mime: 'text/csv', extension: '.csv' },
  tsv: { description: 'Texto separado por tabulação (TSV)', mime: 'text/tab-separated-values', extension: '.tsv' },
} satisfies Record<string, FileKind>;

/** A file on disk the app may write to again (File System Access API handle); opaque elsewhere. */
export type FileHandle = unknown;

/**
 * How written files reach the person. 'file': written to a file they chose (native dialog or the
 * desktop app); the same file can be written again. 'download': the browser downloads a copy to
 * its downloads folder; the open file is never overwritten.
 */
export type SinkMode = 'file' | 'download';

export interface WriteRequest {
  name: string;
  kind: FileKind;
  /** Write to this file again without asking, when the sink can. */
  handle?: FileHandle;
}
export interface Written { name: string; mode: SinkMode; handle?: FileHandle }

/** Rejects with an AbortError when the person cancels. */
export interface FileSink { mode: SinkMode; write(request: WriteRequest, bytes: Uint8Array): Promise<Written> }

/** What the desktop build (and the tests) inject as `window.farivFiles`. */
interface InjectedFiles { save(suggestedName: string, bytes: Uint8Array, kind?: FileKind): Promise<string> }

interface Writable { write(data: Uint8Array): Promise<void>; close(): Promise<void> }
interface NativeHandle {
  name: string;
  createWritable(): Promise<Writable>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface FilePickers {
  showSaveFilePicker?(options: unknown): Promise<NativeHandle>;
  showOpenFilePicker?(options: unknown): Promise<Array<NativeHandle & { getFile(): Promise<File> }>>;
}
const pickers = () => window as unknown as FilePickers;
/** Automation drives downloads; the native dialogs cannot be answered there. */
const nativeDialogs = () => !!pickers().showSaveFilePicker && !navigator.webdriver;

async function writeTo(handle: NativeHandle, bytes: Uint8Array) {
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await handle.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new DOMException('Permissão de escrita negada', 'AbortError');
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** Native dialogs (Chromium desktop): saves in place when the file was opened or saved before. */
const pickerSink: FileSink = {
  mode: 'file',
  async write({ name, kind, handle }, bytes) {
    const target = (handle as NativeHandle | undefined) ?? await pickers().showSaveFilePicker!({
      suggestedName: name, types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }],
    });
    await writeTo(target, bytes);
    return { name: target.name, mode: 'file', handle: target };
  },
};

/** Other browsers and automation: a downloaded copy. */
const downloadSink: FileSink = {
  mode: 'download',
  async write({ name, kind }, bytes) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: kind.mime }));
    const link = document.createElement('a');
    link.href = url;
    // Chromium drops non-ASCII names given through the download attribute; the native
    // save dialog keeps the original name.
    link.download = name.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '_');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { name: link.download, mode: 'download' };
  },
};

function injectedSink(files: InjectedFiles): FileSink {
  return { mode: 'file', write: async ({ name, kind }, bytes) => ({ name: await files.save(name, bytes, kind), mode: 'file' }) };
}

/**
 * The desktop build injects `window.farivFiles` (native file access); tests inject it too.
 * Otherwise the native dialogs, then a download.
 */
export function fileSink(): FileSink {
  const injected = (window as unknown as { farivFiles?: InjectedFiles }).farivFiles;
  if (injected) return injectedSink(injected);
  return nativeDialogs() ? pickerSink : downloadSink;
}

/**
 * Asks for a file to open with the native dialog, keeping its handle so Ctrl+S can write the
 * same file. Null when the browser has no such dialog (the caller uses a file input).
 */
export async function pickFileToOpen(extensions: string[]): Promise<{ file: File; handle: FileHandle } | null> {
  if (!nativeDialogs() || !pickers().showOpenFilePicker) return null;
  const [handle] = await pickers().showOpenFilePicker!({
    types: [{ description: 'Planilhas', accept: { 'application/octet-stream': extensions } }],
  });
  return { file: await handle.getFile(), handle };
}
