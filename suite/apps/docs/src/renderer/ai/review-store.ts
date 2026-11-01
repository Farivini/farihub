import { createReviewStore } from '@genoffice/agent-core'

/**
 * The Fariv reviews of the AI tasks in this document window: the AI panel drives
 * them, the app holds every save (AutoSave and the user's own) while any is open —
 * each task is decided explicitly. The marker is the ProseMirror document node,
 * compared structurally (`sameDoc`).
 */
export const docsReview = createReviewStore<unknown>()

/**
 * Same document: the very node, or a structurally equal one (an undone task rebuilds
 * the document from its restore point, which must equal the state before the task).
 */
export function sameDoc(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const eq = (a as { eq?: (other: unknown) => boolean } | null)?.eq
  return typeof eq === 'function' && b != null && eq.call(a, b)
}
