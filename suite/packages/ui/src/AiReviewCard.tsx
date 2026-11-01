import type { ReviewTask } from '@genoffice/agent-core'
import { aiReviewLabels } from './strings-ai-review'

/**
 * The Fariv review card under an AI task: while the task is pending, the changes
 * live in the editor's draft (previewed in place) and the user accepts or rejects
 * the whole task; afterwards it states what happened. Shared by the three editors —
 * each owns the task state and the actions (see `@genoffice/agent-core` review-task).
 */
export function AiReviewCard({
  task,
  lang,
  onAccept,
  onReject,
}: {
  readonly task: ReviewTask<unknown>
  readonly lang: string
  readonly onAccept: () => void
  readonly onReject: () => void
}) {
  const labels = aiReviewLabels(lang)
  if (task.status === 'running') return null
  if (task.status === 'accepted' && task.changes === 0) return null
  const state = task.conflict ? `conflict-${task.conflict}` : task.status
  return (
    <div className={`ai-review-card ai-review-${task.status}`} data-review={state} role="group">
      {task.status === 'pending' && (
        <>
          <span className="ai-review-text">
            {task.changes === 1
              ? labels.pendingOne
              : labels.pending.replace('{count}', String(task.changes))}
          </span>
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
      {task.status === 'accepted' && <span className="ai-review-text">{labels.accepted}</span>}
      {task.status === 'rejected' && <span className="ai-review-text">{labels.rejected}</span>}
      {task.status === 'rolled-back' && (
        <span className="ai-review-text ai-review-failed">{labels.rolledBack}</span>
      )}
    </div>
  )
}
