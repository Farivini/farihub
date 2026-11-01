import type { FileActionContext } from '../file-actions'

/**
 * The document state a .docx save writes besides the ProseMirror document:
 * headers / footers (and their per-section and variant edits), sections and page
 * setup, page color, page numbering, list numbering, styles, comments, watermark,
 * ink, foot/endnotes, sources, theme, default fonts and document protection.
 *
 * The Fariv review of an AI task snapshots these stores with the document, so a
 * Reject, a failed run or Accept → Undo task restores all of it, and fingerprints
 * them, so a change the user makes to any of them counts as an edit.
 *
 * Track Changes on/off is a mode, not content: it is neither snapshotted nor compared.
 */
const VALUE_KEYS = [
  'section',
  'sections',
  'trailingStartType',
  'pageColor',
  'header',
  'footer',
  'hfVariants',
  'sectionHfEdits',
  'hfLinks',
  'titlePg',
  'evenOddHf',
  'mirrorMargins',
  'pgNumEdit',
  'pendingNumbering',
  'defaultFonts',
  'styleUpserts',
  'comments',
  'watermark',
  'watermarkStyle',
  'watermarkPicture',
  'inkAnnotations',
  'footnotes',
  'endnotes',
  'sources',
  'zoteroDocumentData',
  'themeFonts',
  'themeColors',
  'protection',
  'writeProtection',
  'removePersonalInfo',
] as const

/** the pending-write flags the save drains (restored with the values) */
const DIRTY_KEYS = [
  'sectionDirty',
  'sectionsDirty',
  'pageColorDirty',
  'headerDirty',
  'footerDirty',
  'hfVariantsDirty',
  'pgNumDirtySections',
  'titlePgDirty',
  'evenOddHfDirty',
  'mirrorMarginsDirty',
  'commentsDirty',
  'watermarkDirty',
  'inksDirty',
  'notesDirty',
  'sourcesDirty',
  'zoteroDocumentDataDirty',
  'themeFontsDirty',
  'themeColorsDirty',
  'protectionDirty',
  'writeProtectionDirty',
  'removePersonalInfoDirty',
] as const

type StoreKey = (typeof VALUE_KEYS)[number] | (typeof DIRTY_KEYS)[number]
export type DocStoresSnapshot = Partial<Record<StoreKey, unknown>>

function setterOf(ctx: FileActionContext, key: StoreKey): ((value: unknown) => void) | undefined {
  const name = `set${key[0]!.toUpperCase()}${key.slice(1)}` as keyof FileActionContext
  const setter = ctx[name]
  return typeof setter === 'function' ? (setter as (value: unknown) => void) : undefined
}

/** A deep copy of every store and its pending-write flag. */
export function captureDocStores(ctx: FileActionContext): DocStoresSnapshot {
  const out: DocStoresSnapshot = {}
  for (const key of [...VALUE_KEYS, ...DIRTY_KEYS]) {
    out[key] = structuredClone(ctx[key as keyof FileActionContext])
  }
  return out
}

/** Put every store back (React state: visible after the next render). */
export function restoreDocStores(ctx: FileActionContext, snapshot: DocStoresSnapshot): void {
  for (const key of [...VALUE_KEYS, ...DIRTY_KEYS]) {
    if (!(key in snapshot)) continue
    setterOf(ctx, key)?.(structuredClone(snapshot[key]))
  }
}

function stable(value: unknown): unknown {
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [k, stable(v)]) }
  if (value instanceof Set) return { $set: [...value.values()].map(stable) }
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = stable(v)
    }
    return out
  }
  return value
}

/** Fingerprint of the stores' values (not their pending-write flags). */
export function docStoresFingerprint(ctx: FileActionContext): string {
  const values: Record<string, unknown> = {}
  for (const key of VALUE_KEYS) values[key] = ctx[key as keyof FileActionContext]
  return JSON.stringify(stable(values))
}

/** The stores' values as an effect dependency list (fixed length). */
export function docStoresDeps(ctx: FileActionContext): unknown[] {
  return VALUE_KEYS.map((key) => ctx[key as keyof FileActionContext])
}
