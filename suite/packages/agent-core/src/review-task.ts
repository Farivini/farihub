/**
 * Fariv review of an AI task — one shared model for the three editors.
 *
 * The origin applies the agent's changes straight into the document and saves them
 * with AutoSave. Fariv keeps applying them into the editor's buffer (that is the
 * draft the user previews, in place), but nothing reaches the file until the user
 * accepts the task:
 *
 * - `running`: the agent is working; its changes land in the buffer only.
 * - `pending`: the run ended with changes; the file on disk is untouched and saving
 *   is held until the user decides.
 * - `accepted`: the user kept the task (or saved explicitly); the editor may save.
 * - `rejected`: the user discarded the task; the editor restored the state from
 *   before it, as one step.
 * - `rolled-back`: the run failed after changing the buffer; the editor restored the
 *   state from before it, so a failure never leaves a partial change behind.
 *
 * Conflict: rejecting must only remove the task's own changes. Each editor gives a
 * marker of its document state (sheets: undo depth and journal size; docs: the
 * document JSON; slides: the deck revision); when the marker no longer matches the
 * one taken when the task ended, the document changed afterwards (the user edited,
 * or the file changed on disk) and a one-step undo would take those changes too.
 * The task is then flagged and rejecting is refused — the user can still accept.
 *
 * Pure state: the editors own the buffer, the undo, the snapshot and the save. The
 * agent never writes through any other path: Codex runs read-only and only returns
 * tool calls, which the editor executes into the buffer.
 */

export type ReviewStatus = 'running' | 'pending' | 'accepted' | 'rejected' | 'rolled-back'

export interface ReviewTask<M> {
  readonly id: string
  readonly status: ReviewStatus
  /** operations the agent applied into the buffer during the run */
  readonly changes: number
  /** document marker when the run started */
  readonly before: M
  /** document marker when the run ended (pending onwards) */
  readonly after?: M
  /** why the document no longer matches `after` (conflict) */
  readonly conflict?: ReviewConflict
  /** the run's failure message, when it was rolled back */
  readonly failure?: string
}

/**
 * `edited`: the user changed the document after the task; `disk`: the file changed
 * on disk; `untracked`: the editor kept no undo record of the task (e.g. a batch past
 * its undo budget), so it cannot be removed as one unit.
 */
export type ReviewConflict = 'edited' | 'disk' | 'untracked'

/** What the editor has to do after a transition. */
export type ReviewAction =
  /** nothing to do */
  | 'none'
  /** restore the state from before the task (undo it as one unit) */
  | 'rollback'
  /** the task is kept: AutoSave may write it now */
  | 'commit'

export interface ReviewStep<M> {
  readonly task: ReviewTask<M>
  readonly action: ReviewAction
}

export type SameMarker<M> = (a: M, b: M) => boolean

const defaultSame = <M>(a: M, b: M): boolean => Object.is(a, b)

export function startReview<M>(id: string, before: M): ReviewTask<M> {
  return { id, status: 'running', changes: 0, before }
}

/** The agent applied `count` more operations into the buffer. */
export function recordChanges<M>(task: ReviewTask<M>, count: number): ReviewTask<M> {
  if (task.status !== 'running' || !(count > 0)) return task
  return { ...task, changes: task.changes + count }
}

export interface RunEnd<M> {
  /** document marker now */
  readonly after: M
  /** set when the run failed; a stop by the user is not a failure */
  readonly error?: string | undefined
}

/**
 * The run ended. A run without changes needs no review (it is `accepted` with no
 * action); a failed run with changes is rolled back; anything else goes to review.
 */
export function finishRun<M>(task: ReviewTask<M>, end: RunEnd<M>): ReviewStep<M> {
  if (task.status !== 'running') return { task, action: 'none' }
  if (task.changes === 0)
    return { task: { ...task, status: 'accepted', after: end.after }, action: 'none' }
  if (end.error !== undefined) {
    return {
      task: { ...task, status: 'rolled-back', after: end.after, failure: end.error },
      action: 'rollback',
    }
  }
  return { task: { ...task, status: 'pending', after: end.after }, action: 'none' }
}

/** Accepting keeps the changes; the editor may save them now. */
export function acceptReview<M>(task: ReviewTask<M>): ReviewStep<M> {
  if (task.status !== 'pending') return { task, action: 'none' }
  const { conflict: _conflict, ...rest } = task
  return { task: { ...rest, status: 'accepted' }, action: 'commit' }
}

/**
 * Rejecting removes the task as one unit — only while the document still is what the
 * task left. Otherwise the task is flagged with the conflict and stays pending.
 */
export function rejectReview<M>(
  task: ReviewTask<M>,
  current: M,
  same: SameMarker<M> = defaultSame,
): ReviewStep<M> {
  if (task.status !== 'pending') return { task, action: 'none' }
  if (task.conflict) return { task, action: 'none' }
  if (task.after === undefined || !same(task.after, current)) {
    return { task: { ...task, conflict: 'edited' }, action: 'none' }
  }
  return { task: { ...task, status: 'rejected' }, action: 'rollback' }
}

/** The editor noticed a change that a one-step undo of the task would also revert. */
export function markConflict<M>(task: ReviewTask<M>, reason: ReviewConflict): ReviewTask<M> {
  if (task.status !== 'pending' || task.conflict) return task
  return { ...task, conflict: reason }
}

/** AutoSave (and any implicit save) waits while a task is running or under review. */
export function holdsSave(task: ReviewTask<unknown> | null | undefined): boolean {
  return task?.status === 'running' || task?.status === 'pending'
}

/** An explicit save by the user while a task is pending keeps the task: it counts as accepting. */
export function acceptOnSave<M>(task: ReviewTask<M>): ReviewTask<M> {
  return task.status === 'pending' ? acceptReview(task).task : task
}
