/**
 * Bounded context for the future assistant. The assistant never receives the full sheet:
 * only headers, a capped sample, the selection address and aggregated pivot output.
 */

export const ASSISTANT_LIMITS = { sampleRows: 20, maxColumns: 30, maxCellChars: 200, maxPivotRows: 50 } as const;

export interface AssistantContext {
  workbook: string;
  sheet: string;
  selection: string;
  dataRows: number;
  headers: string[];
  sample: string[][];
  pivot: { rows: string[][]; truncated: boolean } | null;
  limits: typeof ASSISTANT_LIMITS;
}

export function boundContext(input: {
  workbook: string; sheet: string; selection: string; dataRows: number;
  headers: string[]; sample: string[][]; pivotRows: string[][] | null;
}): AssistantContext {
  const clip = (text: string) => text.length > ASSISTANT_LIMITS.maxCellChars ? text.slice(0, ASSISTANT_LIMITS.maxCellChars) + '…' : text;
  const cols = (row: string[]) => row.slice(0, ASSISTANT_LIMITS.maxColumns).map(clip);
  return {
    workbook: input.workbook,
    sheet: input.sheet,
    selection: input.selection,
    dataRows: input.dataRows,
    headers: cols(input.headers),
    sample: input.sample.slice(0, ASSISTANT_LIMITS.sampleRows).map(cols),
    pivot: input.pivotRows
      ? { rows: input.pivotRows.slice(0, ASSISTANT_LIMITS.maxPivotRows).map(cols), truncated: input.pivotRows.length > ASSISTANT_LIMITS.maxPivotRows }
      : null,
    limits: ASSISTANT_LIMITS,
  };
}
