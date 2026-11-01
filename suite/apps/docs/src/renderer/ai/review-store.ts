import { createReviewStore } from '@genoffice/agent-core'

/**
 * The Fariv review of the current AI task in this document window: the AI panel
 * drives it, the app shell holds AutoSave while it is open and treats the user's
 * own Save as accepting it. The marker is the ProseMirror document node (immutable:
 * any change makes a new one), so a conflict is any change after the task.
 */
export const docsReview = createReviewStore<unknown>()
