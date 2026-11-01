import { describe, expect, it } from 'vitest'
import {
  acceptReview,
  confirmRevert,
  createReviewStore,
  finishRun,
  holdsSave,
  markConflict,
  noteAiChange,
  noteUserEdit,
  rebaseAfter,
  rejectReview,
  startReview,
  undoAccepted,
  type ReviewTask,
} from '../src/review-task'

/** A task whose agent made `steps` changes, each moving the marker by one, from `from`. */
function ranTask(steps: number[], from = 0): ReviewTask<number> {
  let task = startReview('t', from)
  let marker = from
  for (const count of steps) {
    task = noteAiChange(task, { before: marker, after: marker + 1, count })
    marker += 1
  }
  return task
}

describe('a run', () => {
  it('goes from running to pending; saving is held all along', () => {
    const task = ranTask([3, 2])
    expect(holdsSave(task)).toBe(true)
    const end = finishRun(task, { after: 2 })
    expect(end.action).toBe('none')
    expect(end.task).toMatchObject({ status: 'pending', changes: 5, before: 0, after: 2 })
    expect(end.task.conflict).toBeUndefined()
    expect(holdsSave(end.task)).toBe(true)
  })

  it('needs no review when the agent changed nothing', () => {
    const end = finishRun(startReview('t', 0), { after: 0 })
    expect(end.task.status).toBe('accepted')
    expect(holdsSave(end.task)).toBe(false)
  })

  it('a run with no change of its own, where the user edited, needs no review either', () => {
    const end = finishRun(startReview('t', 0), { after: 7, error: 'boom' })
    expect(end).toMatchObject({ action: 'none', task: { status: 'accepted' } })
  })
})

describe('a failed run', () => {
  it('is undone, and saving waits until the editor confirms it', () => {
    const end = finishRun(ranTask([4]), { after: 1, error: 'transport closed' })
    expect(end.action).toBe('rollback')
    expect(end.task).toMatchObject({ status: 'reverting', failure: 'transport closed' })
    expect(holdsSave(end.task)).toBe(true)
    const done = confirmRevert(end.task, true)
    expect(done.status).toBe('rolled-back')
    expect(holdsSave(done)).toBe(false)
  })

  it('is not announced as undone when the editor could not confirm it', () => {
    const end = finishRun(ranTask([4]), { after: 1, error: 'boom' })
    const back = confirmRevert(end.task, false)
    expect(back).toMatchObject({ status: 'pending', conflict: 'untracked', failure: 'boom' })
    expect(holdsSave(back)).toBe(true)
    // and it cannot be rejected either: the undo is not available
    expect(rejectReview(back, 1).action).toBe('none')
  })

  it('keeps the user edit made during the run: no undo, the partial changes stay under review', () => {
    let task = startReview('t', 0)
    task = noteAiChange(task, { before: 0, after: 1, count: 2 })
    // the user typed: 1 → 2; then the agent changed again: 2 → 3
    task = noteAiChange(task, { before: 2, after: 3, count: 1 })
    expect(task.interleaved).toBe(true)
    const end = finishRun(task, { after: 3, error: 'boom' })
    expect(end.action).toBe('none')
    expect(end.task).toMatchObject({
      status: 'pending',
      conflict: 'edited',
      failure: 'boom',
      changes: 3,
    })
    expect(holdsSave(end.task)).toBe(true)
    expect(rejectReview(end.task, 3).action).toBe('none')
    // the user decides: keeping it is allowed
    expect(acceptReview(end.task)).toMatchObject({ action: 'commit', task: { status: 'accepted' } })
  })

  it("also keeps a user edit made after the agent's last change", () => {
    const end = finishRun(ranTask([1]), { after: 5, error: 'boom' })
    expect(end).toMatchObject({ action: 'none', task: { status: 'pending', conflict: 'edited' } })
  })

  it("detects a user edit before the agent's first change", () => {
    const task = noteAiChange(startReview('t', 0), { before: 9, after: 10, count: 1 })
    expect(task.interleaved).toBe(true)
  })

  it('does not attempt an undo the editor has no record of', () => {
    let task = startReview('t', 0)
    task = noteAiChange(task, { before: 0, after: 0, count: 200_000, untracked: true })
    const end = finishRun(task, { after: 0, error: 'boom' })
    expect(end).toMatchObject({
      action: 'none',
      task: { status: 'pending', conflict: 'untracked' },
    })
    expect(holdsSave(end.task)).toBe(true)
  })
})

describe('the decision', () => {
  const pending = (): ReviewTask<number> => finishRun(ranTask([2, 3, 1]), { after: 3 }).task

  it('Accept keeps a task of several changes in one action', () => {
    const step = acceptReview(pending())
    expect(step).toMatchObject({ action: 'commit', task: { status: 'accepted', changes: 6 } })
    expect(holdsSave(step.task)).toBe(false)
    expect(acceptReview(step.task).action).toBe('none')
  })

  it('Reject undoes a task of several changes in one action, confirmed by the editor', () => {
    const step = rejectReview(pending(), 3)
    expect(step).toMatchObject({ action: 'rollback', task: { status: 'reverting', changes: 6 } })
    expect(holdsSave(step.task)).toBe(true)
    expect(confirmRevert(step.task, true).status).toBe('rejected')
  })

  it('a Reject that could not be confirmed returns to review, flagged', () => {
    const step = rejectReview(pending(), 3)
    expect(confirmRevert(step.task, false)).toMatchObject({
      status: 'pending',
      conflict: 'untracked',
    })
  })

  it('Reject is refused after the document changed, and the conflict sticks', () => {
    const step = rejectReview(pending(), 4)
    expect(step).toMatchObject({ action: 'none', task: { status: 'pending', conflict: 'edited' } })
    expect(rejectReview(step.task, 3).action).toBe('none')
    expect(acceptReview(step.task).task.conflict).toBeUndefined()
  })

  it('compares markers with the editor-supplied equality', () => {
    let task = startReview<{ d: number }>('t', { d: 0 })
    task = noteAiChange(
      task,
      { before: { d: 0 }, after: { d: 1 }, count: 1 },
      (a, b) => a.d === b.d,
    )
    expect(task.interleaved).toBeUndefined()
    const same = (a: { d: number }, b: { d: number }) => a.d === b.d
    const end = finishRun(task, { after: { d: 1 } }, same).task
    expect(rejectReview(end, { d: 1 }).action).toBe('none') // Object.is on different objects
    expect(rejectReview(end, { d: 1 }, same).action).toBe('rollback')
  })

  it('a change on disk is a conflict too', () => {
    const flagged = markConflict(pending(), 'disk')
    expect(flagged.conflict).toBe('disk')
    expect(rejectReview(flagged, 3).action).toBe('none')
  })

  it('ignores changes and run ends reported after the run ended', () => {
    const task = pending()
    expect(noteAiChange(task, { before: 3, after: 4, count: 5 })).toBe(task)
    expect(finishRun(task, { after: 9 }).task).toBe(task)
    expect(confirmRevert(task, true)).toBe(task)
  })
})

describe('createReviewStore', () => {
  it('keeps every task until decided; saving waits while any is open', () => {
    const store = createReviewStore<number>()
    const seen: string[] = []
    const off = store.subscribe((task) => seen.push(`${task.id}:${task.status}`))
    const a = finishRun({ ...ranTask([1]), id: 'a' }, { after: 1 }).task
    store.set(a)
    // a new request does not touch the pending task
    store.set(startReview('b', 1))
    expect(store.open().map((t) => t.id)).toEqual(['a', 'b'])
    expect(holdsSave(store.list())).toBe(true)
    store.set(finishRun(store.get('b')!, { after: 1 }).task) // b changed nothing
    expect(store.open().map((t) => t.id)).toEqual(['a'])
    expect(holdsSave(store.list())).toBe(true)
    store.set(acceptReview(store.get('a')!).task)
    expect(holdsSave(store.list())).toBe(false)
    off()
    store.set(startReview('c', 1))
    expect(seen).toEqual(['a:pending', 'b:running', 'b:accepted', 'a:accepted'])
  })
})

describe('Accept → Undo task', () => {
  const accepted = (): ReviewTask<number> =>
    acceptReview(finishRun(ranTask([2, 1]), { after: 2 }).task).task

  it('undoes an accepted task of several changes in one action, confirmed by the editor', () => {
    const step = undoAccepted(accepted(), 2)
    expect(step).toMatchObject({ action: 'rollback', task: { status: 'reverting', changes: 3 } })
    expect(holdsSave(step.task)).toBe(true)
    const done = confirmRevert(step.task, true)
    expect(done.status).toBe('undone')
    expect(holdsSave(done)).toBe(false)
  })

  it('an unconfirmed undo leaves the task accepted, flagged, and claims nothing', () => {
    const back = confirmRevert(undoAccepted(accepted(), 2).task, false)
    expect(back).toMatchObject({ status: 'accepted', conflict: 'untracked' })
    expect(undoAccepted(back, 2).action).toBe('none')
  })

  it('is refused once the document changed after the task', () => {
    const step = undoAccepted(accepted(), 5)
    expect(step).toMatchObject({ action: 'none', task: { status: 'accepted', conflict: 'edited' } })
  })

  it('follows a save that rewrote the document without changing it', () => {
    const rebased = rebaseAfter(accepted(), 2, 20)
    expect(undoAccepted(rebased, 20).action).toBe('rollback')
    // a marker that is not the task's end is left alone
    expect(rebaseAfter(accepted(), 7, 20).after).toBe(2)
  })

  it('only accepted tasks with changes can be undone', () => {
    expect(undoAccepted(finishRun(ranTask([1]), { after: 1 }).task, 1).action).toBe('none')
    expect(undoAccepted(finishRun(startReview('e', 0), { after: 0 }).task, 0).action).toBe('none')
  })
})

describe('noteUserEdit', () => {
  it('marks a running task interleaved (a change outside the agent, e.g. a header edit)', () => {
    const task = noteUserEdit(ranTask([1]))
    expect(task.interleaved).toBe(true)
    const end = finishRun(task, { after: 1, error: 'boom' })
    expect(end).toMatchObject({ action: 'none', task: { status: 'pending', conflict: 'edited' } })
    expect(noteUserEdit(end.task)).toBe(end.task)
  })
})
