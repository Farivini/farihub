import { createReviewStore } from '@genoffice/agent-core'

/**
 * The Fariv reviews of the AI tasks in this workbook window: the AI panel drives
 * them, the app holds saving while any is open. The marker is the position in the
 * undo history (depth and identity of the top entry) on a file-backed workbook, a
 * content fingerprint on the in-memory one.
 */
export const sheetsReview = createReviewStore<string>()
