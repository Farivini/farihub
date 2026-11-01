import { createReviewStore } from '@genoffice/agent-core'

/**
 * The Fariv review of the current AI task in this deck window: the AI panel drives
 * it, the app holds AutoSave while it is open and treats the user's own Save as
 * accepting it. The marker is the rendered slide list (a new array on every deck
 * change), so a conflict is any change after the task.
 */
export const slidesReview = createReviewStore<unknown>()
