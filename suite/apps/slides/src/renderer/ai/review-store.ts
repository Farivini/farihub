import { createReviewStore } from '@genoffice/agent-core'

/**
 * The Fariv reviews of the AI tasks in this deck window: the AI panel drives them,
 * the app holds every save (AutoSave and the user's own) while any is open — each
 * task is decided explicitly. The marker is a fingerprint of the deck's content read from the
 * main process (equal content, equal fingerprint).
 */
export const slidesReview = createReviewStore<unknown>()
