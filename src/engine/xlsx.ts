import { parseReport } from '../core/xlsx-report.ts';
import type { XlsxReport } from '../core/xlsx-report.ts';
import { ENGINE_LANGUAGE, ENGINE_LOCALE, ENGINE_TIMEZONE } from './workbook-engine.ts';

/**
 * XLSX conversion with IronCalc's own importer and exporter (vendor/xlsx-bridge, built from
 * native/xlsx-bridge with the same IronCalc 0.9.1 as the engine). The engine never parses
 * XLSX: it receives and hands over `Model.toBytes()` data.
 */
export type XlsxBridge = typeof import('../../vendor/xlsx-bridge/xlsx_bridge.js');

export function xlsxToModel(bridge: XlsxBridge, xlsx: Uint8Array, name: string): { model: Uint8Array; report: XlsxReport } {
  const imported = bridge.importXlsx(xlsx, name, ENGINE_LOCALE, ENGINE_TIMEZONE);
  try {
    return { model: imported.workbook, report: parseReport(imported.report) };
  } finally {
    imported.free();
  }
}

export function modelToXlsx(bridge: XlsxBridge, model: Uint8Array): Uint8Array {
  return bridge.workbookToXlsx(model, ENGINE_LANGUAGE);
}
