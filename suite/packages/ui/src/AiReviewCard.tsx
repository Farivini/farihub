import type { ReviewTask } from '@genoffice/agent-core'
import { aiReviewLabels } from './strings-ai-review'

/**
 * The Fariv review card of an AI task. The task's changes are shown in the open
 * document (a preview in place, not an isolated draft) and the file is untouched
 * until the user accepts or rejects the whole task here; afterwards the card states
 * what happened. Shared by the three editors — each owns the task state and the
 * actions (see `@genoffice/agent-core` review-task).
 */
export function AiReviewCard({
  task,
  lang,
  onAccept,
  onReject,
  onUndo,
}: {
  readonly task: ReviewTask<unknown>
  readonly lang: string
  readonly onAccept: () => void
  readonly onReject: () => void
  /** Accept → Undo task; omitted where the editor does not offer it */
  readonly onUndo?: (() => void) | undefined
}) {
  const labels = aiReviewLabels(lang)
  if (task.status === 'running') return null
  if (task.status === 'accepted' && task.changes === 0) return null
  const state = task.conflict ? `conflict-${task.conflict}` : task.status
  return (
    <div
      className={`ai-review-card ai-review-${task.status}`}
      data-review={state}
      data-task={task.id}
      role="group"
    >
      {task.status === 'pending' && (
        <>
          <span className="ai-review-text">
            {task.changes === 1
              ? labels.pendingOne
              : labels.pending.replace('{count}', String(task.changes))}
          </span>
          {task.failure !== undefined && (
            <span className="ai-review-failed-kept" role="alert">
              {labels.failedKept}
            </span>
          )}
          {task.conflict && (
            <span className="ai-review-conflict" role="alert">
              {task.conflict === 'disk'
                ? labels.conflictDisk
                : task.conflict === 'untracked'
                  ? labels.conflictUntracked
                  : labels.conflictEdited}
            </span>
          )}
          <span className="ai-review-actions">
            <button
              type="button"
              className="ai-review-btn ai-review-accept"
              title={labels.acceptTitle}
              onClick={onAccept}
            >
              {labels.accept}
            </button>
            <button
              type="button"
              className="ai-review-btn ai-review-reject"
              title={labels.rejectTitle}
              disabled={Boolean(task.conflict)}
              onClick={onReject}
            >
              {labels.reject}
            </button>
          </span>
        </>
      )}
      {task.status === 'reverting' && <span className="ai-review-text">{labels.reverting}</span>}
      {task.status === 'accepted' && (
        <>
          <span className="ai-review-text">{labels.accepted}</span>
          {onUndo && task.changes > 0 && task.conflict && (
            <span className="ai-review-conflict" role="alert">
              {labels.undoUnavailable}
            </span>
          )}
          {onUndo && task.changes > 0 && (
            <span className="ai-review-actions">
              <button
                type="button"
                className="ai-review-btn ai-review-undo"
                title={labels.undoTaskTitle}
                disabled={Boolean(task.conflict)}
                onClick={onUndo}
              >
                {labels.undoTask}
              </button>
            </span>
          )}
        </>
      )}
      {task.status === 'undone' && <span className="ai-review-text">{labels.undone}</span>}
      {task.status === 'rejected' && <span className="ai-review-text">{labels.rejected}</span>}
      {task.status === 'rolled-back' && (
        <span className="ai-review-text ai-review-failed">{labels.rolledBack}</span>
      )}
    </div>
  )
}

/**
 * Tasks still waiting for a decision whose reply is no longer in the conversation
 * (the user started a new one): they stay reachable here until accepted or rejected.
 */
export function AiOpenReviews({
  tasks,
  lang,
  onAccept,
  onReject,
}: {
  readonly tasks: readonly ReviewTask<unknown>[]
  readonly lang: string
  readonly onAccept: (taskId: string) => void
  readonly onReject: (taskId: string) => void
}) {
  const shown = tasks.filter((task) => task.status === 'pending' || task.status === 'reverting')
  if (shown.length === 0) return null
  return (
    <section className="ai-review-open" aria-label={aiReviewLabels(lang).openTitle}>
      <div className="ai-review-open-title">{aiReviewLabels(lang).openTitle}</div>
      {shown.map((task) => (
        <AiReviewCard
          key={task.id}
          task={task}
          lang={lang}
          onAccept={() => onAccept(task.id)}
          onReject={() => onReject(task.id)}
        />
      ))}
    </section>
  )
}
