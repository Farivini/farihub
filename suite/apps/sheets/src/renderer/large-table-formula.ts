/// Kept apart from large-table-calc.ts so the command guard can use it
/// without importing the grid-sync module (an import cycle).

/// The one cell a set-range-values command writes a formula into, or null
/// (several cells, no formula). The command carries the cell as an object or
/// as a row → column matrix.
export function singleFormulaCell(
  params: Record<string, unknown>,
): { row: number; column: number; formula: string } | null {
  const formulaOf = (cell: unknown): string | null => {
    if (typeof cell !== 'object' || cell === null) return null
    const record = cell as Record<string, unknown>
    if (typeof record.f === 'string' && record.f.startsWith('=') && record.f.length > 1) {
      return record.f
    }
    if (typeof record.v === 'string' && record.v.startsWith('=') && record.v.length > 1) {
      return record.v
    }
    return null
  }
  const value = params.value
  if (typeof value !== 'object' || value === null) return null
  const range = params.range as { startRow?: unknown; startColumn?: unknown } | undefined
  const direct = value as Record<string, unknown>
  if ('f' in direct || 'v' in direct) {
    const formula = formulaOf(direct)
    if (formula === null || typeof range?.startRow !== 'number') return null
    if (typeof range.startColumn !== 'number') return null
    return { row: range.startRow, column: range.startColumn, formula }
  }
  let found: { row: number; column: number; formula: string } | null = null
  for (const [rowKey, rowValue] of Object.entries(direct)) {
    if (typeof rowValue !== 'object' || rowValue === null) return null
    for (const [columnKey, cell] of Object.entries(rowValue as Record<string, unknown>)) {
      const formula = formulaOf(cell)
      if (formula === null) continue
      if (found !== null) return null
      found = { row: Number(rowKey), column: Number(columnKey), formula }
    }
  }
  return found
}
