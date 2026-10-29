/**
 * Reproducible synthetic sales base. Same seed and row count always produce the same rows.
 * Values are generated as pt-BR input text (comma decimal), as a user would type them.
 */

export const SYNTHETIC_HEADERS = ['Região', 'Canal', 'Categoria', 'Quantidade', 'Receita'] as const;
export const REGIONS = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];
export const CHANNELS = ['Loja física', 'E-commerce', 'Atacado'];
export const CATEGORIES = ['Eletrônicos', 'Vestuário', 'Alimentação', 'Papelaria', 'Decoração', 'Higiene', 'Brinquedos', 'Automóveis'];
export const DEFAULT_SEED = 20261029;

/** mulberry32: small deterministic PRNG, not for cryptography. */
export function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticRow {
  region: number; channel: number; category: number; quantity: number;
  /** Revenue in cents, kept as an integer so expected totals are exact. */
  revenueCents: number;
}

export function* syntheticRows(count: number, seed = DEFAULT_SEED): Generator<SyntheticRow> {
  const next = prng(seed);
  for (let i = 0; i < count; i++) {
    const region = Math.floor(next() * REGIONS.length);
    const channel = Math.floor(next() * CHANNELS.length);
    const category = Math.floor(next() * CATEGORIES.length);
    const quantity = 1 + Math.floor(next() * 20);
    const unitCents = 500 + Math.floor(next() * 49_500);
    yield { region, channel, category, quantity, revenueCents: quantity * unitCents };
  }
}

export function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

export function rowToInputs(row: SyntheticRow): string[] {
  return [REGIONS[row.region], CHANNELS[row.channel], CATEGORIES[row.category], String(row.quantity), centsToInput(row.revenueCents)];
}

/** Independent expectation, computed from the generator only (never from the engine). */
export interface SyntheticTotals {
  rows: number;
  quantity: number;
  revenueCents: number;
  revenueCentsByRegion: number[];
  rowsByRegionChannel: number[][];
}

export function syntheticTotals(count: number, seed = DEFAULT_SEED): SyntheticTotals {
  const totals: SyntheticTotals = {
    rows: 0, quantity: 0, revenueCents: 0,
    revenueCentsByRegion: REGIONS.map(() => 0),
    rowsByRegionChannel: REGIONS.map(() => CHANNELS.map(() => 0)),
  };
  for (const row of syntheticRows(count, seed)) {
    totals.rows++;
    totals.quantity += row.quantity;
    totals.revenueCents += row.revenueCents;
    totals.revenueCentsByRegion[row.region] += row.revenueCents;
    totals.rowsByRegionChannel[row.region][row.channel]++;
  }
  return totals;
}

/** Aggregate formulas placed on the "Resumo" sheet of the synthetic base (pt-BR syntax). */
export function summaryFormulas(count: number): Array<[string, string]> {
  const last = count + 1;
  return [
    ['Receita total', `=SOMA(Dados!E2:E${last})`],
    ['Receita Sul', `=SOMASE(Dados!A2:A${last};"Sul";Dados!E2:E${last})`],
    ['Linhas', `=CONT.VALORES(Dados!A2:A${last})`],
  ];
}
