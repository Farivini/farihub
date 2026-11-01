/**
 * Fariv review of an AI task — one shared model for the three editors.
 *
 * Preview, not an isolated draft: the agent's changes are applied to the document
 * that is open in the editor (that is the preview the user sees), and the file on
 * disk is not written until the user decides. What this model guarantees:
 *
 * - `running`: the agent is working; its changes land in the open document only.
 * - `pending`: the run ended with changes; nothing is saved until the user decides.
 *   A pending task stays pending — a new request, a new conversation or the user's
 *   own Save never accept it implicitly.
 * - `reverting`: the editor is undoing the task (Reject, or a failed run). Saving
 *   stays held until the editor confirms the document is back to its state from
 *   before the task (`confirmRevert`); an unconfirmed revert returns to `pending`.
 * - `accepted` / `rejected` / `rolled-back`: final.
 *
 * The user's edits are never undone with the task. Each change of the agent is
 * recorded with the editor's document marker before and after it; when the
 * document changed between two changes of the agent, or after its last one, the
 * user edited it meanwhile (`interleaved`). Undoing the task as a unit would then
 * take the user's edit too, so the editor does not: a failed run keeps the partial
 * changes under review (flagged), and Reject is refused (Accept stays possible).
 * The same holds when the editor kept no undo record of a change (`untracked`).
 *
 * Pure state: the editors own the document, the undo, the snapshot and the save.
 */

export type ReviewStatus =
  | 'running'
  | 'pending'
  | 'reverting'
  | 'accepted'
  | 'rejected'
  | 'rolled-back'
  /** accepted, then undone as a whole by the user (Accept → Undo task) */
  | 'undone'

/**
 * Why the task cannot be undone as a unit:
 * `edited`: the user changed the document during or after the task;
 * `disk`: the file changed on disk after the task;
 * `untracked`: the editor kept no undo record of a change (e.g. a batch past its
 * undo budget), or undoing it could not be confirmed.
 */
export type ReviewConflict = 'edited' | 'disk' | 'untracked'

export interface ReviewTask<M> {
  readonly id: string
  readonly status: ReviewStatus
  /** operations the agent applied to the open document during the run */
  readonly changes: number
  /** document marker when the run started */
  readonly before: M
  /** document marker right after the agent's latest change */
  readonly last?: M
  /** document marker when the run ended (pending onwards) */
  readonly after?: M
  /** the user changed the document between the agent's changes */
  readonly interleaved?: boolean
  /** a change of the agent left no undo record */
  readonly untracked?: boolean
  /** why the task cannot be undone as a unit */
  readonly conflict?: ReviewConflict
  /** the run's failure message, when it failed */
  readonly failure?: string
  /** what the pending revert is for */
  readonly reverting?: 'reject' | 'failure' | 'undo'
}

/** What the editor has to do after a transition. */
export type ReviewAction =
  /** nothing to do */
  | 'none'
  /** undo the task as a unit, then call confirmRevert with the outcome */
  | 'rollback'
  /** the task is kept: AutoSave may write it once nothing else is under review */
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

export interface AiChange<M> {
  /** document marker right before the agent's change */
  readonly before: M
  /** document marker right after it */
  readonly after: M
  /** operations in the change */
  readonly count: number
  /** the editor kept no undo record of this change */
  readonly untracked?: boolean
}

/**
 * The agent changed the open document. When the document no longer is what the
 * agent left it (or what it was at the start), the user edited in between.
 */
export function noteAiChange<M>(
  task: ReviewTask<M>,
  change: AiChange<M>,
  same: SameMarker<M> = defaultSame,
): ReviewTask<M> {
  if (task.status !== 'running') return task
  const expected = task.last ?? task.before
  const interleaved = task.interleaved || !same(expected, change.before)
  return {
    ...task,
    changes: task.changes + Math.max(0, change.count),
    last: change.after,
    ...(interleaved ? { interleaved: true } : {}),
    ...(task.untracked || change.untracked ? { untracked: true } : {}),
  }
}

export interface RunEnd<M> {
  /** document marker now */
  readonly after: M
  /** set when the run failed; a stop by the user is not a failure */
  readonly error?: string | undefined
}

/**
 * The run ended. Without changes there is nothing to review. A failed run is undone
 * — unless the user edited meanwhile or a change left no undo record: then its
 * partial changes stay under review, flagged, and the user decides.
 */
export function finishRun<M>(
  task: ReviewTask<M>,
  end: RunEnd<M>,
  same: SameMarker<M> = defaultSame,
): ReviewStep<M> {
  if (task.status !== 'running') return { task, action: 'none' }
  const interleaved =
    task.interleaved || (task.changes > 0 && !same(task.last ?? task.before, end.after))
  const base: ReviewTask<M> = {
    ...task,
    after: end.after,
    ...(interleaved ? { interleaved: true } : {}),
    ...(end.error !== undefined ? { failure: end.error } : {}),
  }
  if (task.changes === 0) return { task: { ...base, status: 'accepted' }, action: 'none' }
  const conflict: ReviewConflict | undefined = interleaved
    ? 'edited'
    : task.untracked
      ? 'untracked'
      : undefined
  if (conflict) return { task: { ...base, status: 'pending', conflict }, action: 'none' }
  if (end.error !== undefined) {
    return { task: { ...base, status: 'reverting', reverting: 'failure' }, action: 'rollback' }
  }
  return { task: { ...base, status: 'pending' }, action: 'none' }
}

/** Accepting keeps the changes; the editor may save them once nothing else is open. */
export function acceptReview<M>(task: ReviewTask<M>): ReviewStep<M> {
  if (task.status !== 'pending') return { task, action: 'none' }
  const { conflict: _conflict, ...rest } = task
  return { task: { ...rest, status: 'accepted' }, action: 'commit' }
}

/**
 * Rejecting undoes the task as a unit — only while the document still is what the
 * task left and the task can be undone. Otherwise the task is flagged and stays pending.
 */
export function rejectReview<M>(
  task: ReviewTask<M>,
  current: M,
  same: SameMarker<M> = defaultSame,
): ReviewStep<M> {
  if (task.status !== 'pending') return { task, action: 'none' }
  if (task.conflict) return { task, action: 'none' }
  if (task.untracked) return { task: { ...task, conflict: 'untracked' }, action: 'none' }
  if (task.after === undefined || !same(task.after, current)) {
    return { task: { ...task, conflict: 'edited' }, action: 'none' }
  }
  return { task: { ...task, status: 'reverting', reverting: 'reject' }, action: 'rollback' }
}

/**
 * The editor finished undoing the task. Only a confirmed revert (the document is
 * back to its state from before the task) ends it; otherwise the task returns to
 * review, flagged `untracked`, and saving stays held.
 */
export function confirmRevert<M>(task: ReviewTask<M>, reverted: boolean): ReviewTask<M> {
  if (task.status !== 'reverting') return task
  const { reverting, ...rest } = task
  if (!reverted) {
    // an unconfirmed undo of an accepted task leaves it accepted (its changes stay)
    return { ...rest, status: reverting === 'undo' ? 'accepted' : 'pending', conflict: 'untracked' }
  }
  return {
    ...rest,
    status: reverting === 'failure' ? 'rolled-back' : reverting === 'undo' ? 'undone' : 'rejected',
  }
}

/**
 * Accept → Undo task: an accepted task is undone as a unit, while the document still
 * is what the task left (no edit, no other task since). Saving waits for the editor's
 * confirmation, as for a Reject; the undone state is then saved like any change.
 */
export function undoAccepted<M>(
  task: ReviewTask<M>,
  current: M,
  same: SameMarker<M> = defaultSame,
): ReviewStep<M> {
  if (task.status !== 'accepted' || task.changes === 0) return { task, action: 'none' }
  if (task.conflict) return { task, action: 'none' }
  if (task.untracked) return { task: { ...task, conflict: 'untracked' }, action: 'none' }
  if (task.after === undefined || !same(task.after, current)) {
    return { task: { ...task, conflict: 'edited' }, action: 'none' }
  }
  return { task: { ...task, status: 'reverting', reverting: 'undo' }, action: 'rollback' }
}

/**
 * The editor rewrote the document without changing its content (a save that reloads
 * the file): the task's end marker follows, so a later Undo still matches.
 */
export function rebaseAfter<M>(
  task: ReviewTask<M>,
  from: M,
  to: M,
  same: SameMarker<M> = defaultSame,
): ReviewTask<M> {
  if (task.after === undefined || !same(task.after, from)) return task
  return { ...task, after: to }
}

/** The user edited the document while the task was running (outside the agent's changes). */
export function noteUserEdit<M>(task: ReviewTask<M>): ReviewTask<M> {
  if (task.status !== 'running' || task.interleaved) return task
  return { ...task, interleaved: true }
}

/** The editor noticed a change that undoing the task would also revert. */
export function markConflict<M>(task: ReviewTask<M>, reason: ReviewConflict): ReviewTask<M> {
  if ((task.status !== 'pending' && task.status !== 'accepted') || task.conflict) return task
  return { ...task, conflict: reason }
}

/** The task still keeps the file from being written. */
export function isOpenReview(task: ReviewTask<unknown> | null | undefined): boolean {
  return task?.status === 'running' || task?.status === 'pending' || task?.status === 'reverting'
}

/** Saving waits while any task is running, under review or being undone. */
export function holdsSave(
  tasks: ReviewTask<unknown> | readonly ReviewTask<unknown>[] | null | undefined,
): boolean {
  if (!tasks) return false
  return Array.isArray(tasks)
    ? tasks.some(isOpenReview)
    : isOpenReview(tasks as ReviewTask<unknown>)
}

/**
 * The tasks of one editor window, shared between the AI panel (which drives them)
 * and the editor shell (which holds saving while any is open). Tasks stay until
 * decided: nothing here accepts one implicitly.
 */
export interface ReviewStore<M> {
  get(id: string): ReviewTask<M> | undefined
  list(): readonly ReviewTask<M>[]
  /** the open tasks (running, pending or being undone), oldest first */
  open(): readonly ReviewTask<M>[]
  set(task: ReviewTask<M>): void
  subscribe(listener: (task: ReviewTask<M>) => void): () => void
}

export function createReviewStore<M>(): ReviewStore<M> {
  const tasks = new Map<string, ReviewTask<M>>()
  const listeners = new Set<(task: ReviewTask<M>) => void>()
  return {
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    open: () => [...tasks.values()].filter(isOpenReview),
    set(task) {
      tasks.set(task.id, task)
      for (const listener of [...listeners]) listener(task)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
