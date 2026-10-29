/** Numeric snapshot for aggregation, not the authoritative spreadsheet model. */
export interface NumericTable {
  rowCount: number;
  region: Uint8Array;
  revenueCents: Float64Array;
  costCents: Float64Array;
}

export interface Group {
  region: number;
  count: number;
  revenueCents: number;
  costCents: number;
  margin: number | null;
}

export interface PivotSpec {
  region?: number;
  minRevenueCents?: number;
}

export function validateTable(table: NumericTable): void {
  if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) {
    throw new RangeError('Invalid row count');
  }
  for (const column of [table.region, table.revenueCents, table.costCents]) {
    if (column.length !== table.rowCount) throw new RangeError('Column length mismatch');
  }
}

/** Deterministic fixture: repeated five-row cycles; not customer data. */
export function makeFixture(rowCount: number): NumericTable {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 1_000_000) {
    throw new RangeError('Fixture supports 0 through 1,000,000 rows');
  }
  const table: NumericTable = {
    rowCount,
    region: new Uint8Array(rowCount),
    revenueCents: new Float64Array(rowCount),
    costCents: new Float64Array(rowCount),
  };
  for (let row = 0; row < rowCount; row++) {
    const region = row % 5;
    table.region[row] = region;
    table.revenueCents[row] = (region + 1) * 10_000;
    table.costCents[row] = (region + 1) * 6_000;
  }
  return table;
}

/** Small fixed schema only. This is not a general spreadsheet pivot implementation. */
export function pivotByRegion(table: NumericTable, spec: PivotSpec = {}): Group[] {
  validateTable(table);
  if (spec.region !== undefined && (!Number.isInteger(spec.region) || spec.region < 0 || spec.region > 255)) {
    throw new RangeError('Invalid region');
  }
  if (spec.minRevenueCents !== undefined && !Number.isSafeInteger(spec.minRevenueCents)) {
    throw new RangeError('Invalid minimum revenue');
  }
  const groups = new Map<number, Group>();
  for (let row = 0; row < table.rowCount; row++) {
    const region = table.region[row];
    const revenue = table.revenueCents[row];
    const cost = table.costCents[row];
    if (!Number.isSafeInteger(revenue) || !Number.isSafeInteger(cost)) {
      throw new RangeError(`Invalid money at row ${row + 1}`);
    }
    if (spec.region !== undefined && region !== spec.region) continue;
    if (spec.minRevenueCents !== undefined && revenue < spec.minRevenueCents) continue;
    let group = groups.get(region);
    if (!group) {
      group = { region, count: 0, revenueCents: 0, costCents: 0, margin: null };
      groups.set(region, group);
    }
    group.count++;
    group.revenueCents += revenue;
    group.costCents += cost;
    if (!Number.isSafeInteger(group.revenueCents) || !Number.isSafeInteger(group.costCents)) {
      throw new RangeError('Money exceeds safe integer range');
    }
  }
  return [...groups.values()].sort((a, b) => a.region - b.region).map(group => ({
    ...group,
    margin: group.revenueCents === 0 ? null : (group.revenueCents - group.costCents) / group.revenueCents,
  }));
}
