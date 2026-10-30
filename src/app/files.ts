import { FILE_EXTENSION } from '../core/file-format.ts';

/**
 * Where a saved workbook goes. Resolves with the name it was saved under; rejects with an
 * AbortError when the person cancels.
 */
export interface FileSink { save(suggestedName: string, bytes: Uint8Array): Promise<string> }

interface SaveFilePicker {
  showSaveFilePicker?(options: unknown): Promise<{ name: string; createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

/** Native save dialog where the browser has one (Chromium desktop). */
const pickerSink: FileSink = {
  async save(name, bytes) {
    const picker = window as unknown as SaveFilePicker;
    const handle = await picker.showSaveFilePicker!({ suggestedName: name, types: [{ description: 'Pasta de trabalho Fariv', accept: { 'application/x-farcel': [FILE_EXTENSION] } }] });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    return handle.name;
  },
};

/** Download fallback for other browsers and automation. */
const downloadSink: FileSink = {
  async save(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-farcel' }));
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
