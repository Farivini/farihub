import { createReviewStore } from '@genoffice/agent-core'
import type { DocStoresSnapshot } from './doc-stores'

/**
 * The Fariv reviews of the AI tasks in this document window: the AI panel drives
 * them, the app holds every save (AutoSave and the user's own) while any is open —
 * each task is decided explicitly.
 *
 * A task covers everything a .docx save writes: the ProseMirror document and the
 * document stores beside it (headers / footers, sections and page setup, styles,
 * comments, notes, watermark, theme… — see doc-stores.ts). The marker is both:
 * the document node (compared structurally) and a fingerprint of the stores.
 */
export interface DocsMarker {
  readonly doc: unknown
  /** fingerprint of the document stores; absent on the per-tool markers, which
   * compare the document only (store edits by the user are reported as events) */
  readonly stores?: string
}

export const docsReview = createReviewStore<DocsMarker>()

/**
 * Same document: the very node, or a structurally equal one (an undone task rebuilds
 * the document from its restore point, which must equal the state before the task).
 */
export function sameDoc(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const eq = (a as { eq?: (other: unknown) => boolean } | null)?.eq
  return typeof eq === 'function' && b != null && eq.call(a, b)
}

/** Same document and, where both markers carry them, the same stores. */
export function sameDocsMarker(a: DocsMarker, b: DocsMarker): boolean {
  if (!sameDoc(a.doc, b.doc)) return false
  return a.stores === undefined || b.stores === undefined || a.stores === b.stores
}

/** The whole session a task can be undone to: file base, document, stores. */
export interface DocsSessionSnapshot {
  /** the parsed package the document's anchors point into (changes on save) */
  readonly parsed: unknown
  /** ProseMirror JSON */
  readonly pm: unknown
  readonly stores: DocStoresSnapshot
}

/**
 * What the app gives the review (it owns the editor, the file context and React state).
 * Store writes are React state: they show after the next render, so markers and
 * confirmations wait for `settled()`.
 */
export interface DocsReviewHost {
  /** resolves after React has committed every state update made so far */
  settled(): Promise<void>
  /** the current marker (call after `settled()` for store writes to be included) */
  marker(): DocsMarker
  capture(): DocsSessionSnapshot | null
  /** put the session back; false when it cannot be applied (no editor / document) */
  restore(snapshot: DocsSessionSnapshot): boolean
  /** called with the stores' fingerprint after each committed change to them */
  subscribeStores(listener: (fingerprint: string) => void): () => void
}

export const docsReviewHost: { current: DocsReviewHost | null } = { current: null }
