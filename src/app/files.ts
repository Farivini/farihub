import { FILE_EXTENSION } from '../core/file-format.ts';

export interface FileKind { description: string; mime: string; extension: string }

export const FILE_KINDS = {
  farcel: { description: 'Pasta de trabalho Fariv', mime: 'application/x-farcel', extension: FILE_EXTENSION },
  xlsx: { description: 'Pasta de trabalho do Excel', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
  csv: { description: 'Texto separado por ponto e vírgula (CSV)', mime: 'text/csv', extension: '.csv' },
  tsv: { description: 'Texto separado por tabulação (TSV)', mime: 'text/tab-separated-values', extension: '.tsv' },
} satisfies Record<string, FileKind>;

/**
 * Where a saved or exported file goes. Resolves with the name it was saved under; rejects with
 * an AbortError when the person cancels.
 */
export interface FileSink { save(suggestedName: string, bytes: Uint8Array, kind?: FileKind): Promise<string> }

interface SaveFilePicker {
  showSaveFilePicker?(options: unknown): Promise<{ name: string; createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

/** Native save dialog where the browser has one (Chromium desktop). */
const pickerSink: FileSink = {
  async save(name, bytes, kind = FILE_KINDS.farcel) {
    const picker = window as unknown as SaveFilePicker;
    const handle = await picker.showSaveFilePicker!({ suggestedName: name, types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }] });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return handle.name;
  },
};

/** Download fallback for other browsers and automation. */
const downloadSink: FileSink = {
  async save(name, bytes, kind = FILE_KINDS.farcel) {
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
    return link.download;
  },
};

/**
 * The desktop build injects `window.farivFiles` (native file access); tests inject it too.
 * Otherwise the native dialog, then a download.
 */
export function fileSink(): FileSink {
  const injected = (window as unknown as { farivFiles?: FileSink }).farivFiles;
  if (injected) return injected;
  if ((window as unknown as SaveFilePicker).showSaveFilePicker && !navigator.webdriver) return pickerSink;
  return downloadSink;
}
