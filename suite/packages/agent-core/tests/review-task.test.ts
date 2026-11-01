import { describe, expect, it } from 'vitest'
import {
  acceptOnSave,
  acceptReview,
  finishRun,
  holdsSave,
  markConflict,
  recordChanges,
  rejectReview,
  startReview,
} from '../src/review-task'

describe('review of an AI task', () => {
  it('goes from running to pending with the changes applied into the buffer', () => {
    let task = startReview('t1', 10)
    expect(holdsSave(task)).toBe(true)
    task = recordChanges(task, 3)
    task = recordChanges(task, 2)
    const end = finishRun(task, { after: 15 })
    expect(end.action).toBe('none')
    expect(end.task).toMatchObject({ status: 'pending', changes: 5, before: 10, after: 15 })
    expect(holdsSave(end.task)).toBe(true)
  })

  it('needs no review when the run changed nothing', () => {
    const end = finishRun(startReview('t', 0), { after: 0 })
    expect(end.task.status).toBe('accepted')
    expect(end.action).toBe('none')
    expect(holdsSave(end.task)).toBe(false)
  })

  it('rolls a failed run back instead of leaving a partial change', () => {
    const task = recordChanges(startReview('t', 'a'), 4)
    const end = finishRun(task, { after: 'b', error: 'transport closed' })
    expect(end.action).toBe('rollback')
    expect(end.task).toMatchObject({ status: 'rolled-back', failure: 'transport closed' })
    expect(holdsSave(end.task)).toBe(false)
  })

  it('a failed run without changes has nothing to roll back', () => {
    const end = finishRun(startReview('t', 'a'), { after: 'a', error: 'boom' })
    expect(end.action).toBe('none')
  })

  it('accepting commits; the task no longer holds the save', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 1), { after: 2 }).task
    const step = acceptReview(pending)
    expect(step.action).toBe('commit')
    expect(step.task.status).toBe('accepted')
    expect(holdsSave(step.task)).toBe(false)
    // accepting twice is a no-op
    expect(acceptReview(step.task).action).toBe('none')
  })

  it('rejecting undoes the whole task while the document is what the task left', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 7), { after: 2 }).task
    const step = rejectReview(pending, 2)
    expect(step.action).toBe('rollback')
    expect(step.task.status).toBe('rejected')
  })

  it('refuses to reject after the document changed, and flags the conflict', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 1), { after: 2 }).task
    const step = rejectReview(pending, 3)
    expect(step.action).toBe('none')
    expect(step.task).toMatchObject({ status: 'pending', conflict: 'edited' })
    // still refused even if the marker comes back (e.g. undo + a different edit)
    expect(rejectReview(step.task, 2).action).toBe('none')
    // the user can still keep the task
    expect(acceptReview(step.task)).toMatchObject({
      action: 'commit',
      task: { status: 'accepted' },
    })
    expect(acceptReview(step.task).task.conflict).toBeUndefined()
  })

  it('compares markers with the editor-supplied equality', () => {
    const pending = finishRun(recordChanges(startReview('t', { d: 1 }), 1), {
      after: { d: 2 },
    }).task
    const same = (a: { d: number }, b: { d: number }) => a.d === b.d
    expect(rejectReview(pending, { d: 2 }).action).toBe('none') // different objects, Object.is
    expect(rejectReview(pending, { d: 2 }, same).action).toBe('rollback')
  })

  it('a change on disk is a conflict too', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 1), { after: 2 }).task
    const flagged = markConflict(pending, 'disk')
    expect(flagged.conflict).toBe('disk')
    expect(rejectReview(flagged, 2).action).toBe('none')
    // only pending tasks are flagged
    expect(markConflict(acceptReview(pending).task, 'disk').conflict).toBeUndefined()
  })

  it('an explicit save keeps a pending task', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 1), { after: 2 }).task
    expect(acceptOnSave(pending).status).toBe('accepted')
    const running = startReview('r', 1)
    expect(acceptOnSave(running)).toBe(running)
  })

  it('ignores changes reported after the run ended', () => {
    const pending = finishRun(recordChanges(startReview('t', 1), 1), { after: 2 }).task
    expect(recordChanges(pending, 5)).toBe(pending)
    expect(finishRun(pending, { after: 9 }).task).toBe(pending)
  })
})
