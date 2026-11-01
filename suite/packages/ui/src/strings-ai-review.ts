import type { Lang } from '@genoffice/i18n'

/** Labels of the Fariv review card under an AI task (all three editors). */
export interface AiReviewLabels {
  /** pending: `{count}` changes shown in the open document; the file is untouched */
  pending: string
  /** pending with a single change */
  pendingOne: string
  accept: string
  reject: string
  acceptTitle: string
  rejectTitle: string
  accepted: string
  rejected: string
  /** a failed run whose changes were undone (confirmed) */
  rolledBack: string
  /** the task is being undone; saving waits for the confirmation */
  reverting: string
  /** the run failed; its partial changes were kept under review instead of undone */
  failedKept: string
  /** the document changed during or after the task: rejecting would undo those changes too */
  conflictEdited: string
  /** the file changed on disk after the task */
  conflictDisk: string
  /** the editor kept no undo record of the task, or undoing it could not be confirmed */
  conflictUntracked: string
  /** heading of the tasks still waiting for a decision (shown after a new conversation) */
  openTitle: string
  /** Accept → undo the whole task (button and tooltip) */
  undoTask: string
  undoTaskTitle: string
  /** an accepted task undone as a whole */
  undone: string
  /** an accepted task that can no longer be undone as a whole */
  undoUnavailable: string
}

const pt: AiReviewLabels = {
  pending: '{count} alterações da IA no documento aberto — o arquivo ainda não foi alterado',
  pendingOne: '1 alteração da IA no documento aberto — o arquivo ainda não foi alterado',
  accept: 'Aceitar',
  reject: 'Rejeitar',
  acceptTitle: 'Manter as alterações da IA (e salvar, com o salvamento automático ligado)',
  rejectTitle: 'Desfazer a tarefa inteira da IA',
  accepted: 'Alterações aceitas',
  rejected: 'Tarefa desfeita',
  rolledBack: 'A tarefa falhou; as alterações dela foram desfeitas',
  reverting: 'Desfazendo a tarefa… o arquivo só é salvo depois de confirmado',
  failedKept:
    'A tarefa falhou. As alterações parciais não foram desfeitas automaticamente; ficam aqui para você decidir.',
  conflictEdited:
    'O documento recebeu edições suas durante ou depois da tarefa. Rejeitar desfaria também essas edições, então não está disponível; aceite ou use Desfazer (Ctrl+Z) passo a passo.',
  conflictDisk:
    'O arquivo mudou no disco depois da tarefa. Rejeitar não é seguro; aceite ou reabra o arquivo.',
  conflictUntracked:
    'Não há histórico suficiente para desfazer esta tarefa de uma vez. Aceite, ou feche o arquivo sem salvar para descartá-la.',
  openTitle: 'Alterações da IA aguardando decisão',
  undoTask: 'Desfazer tarefa',
  undoTaskTitle: 'Desfazer de uma vez todas as alterações desta tarefa aceita',
  undone: 'Tarefa aceita e depois desfeita',
  undoUnavailable:
    'Esta tarefa não pode mais ser desfeita de uma vez: o documento mudou depois dela ou não há histórico suficiente. Use Desfazer (Ctrl+Z) passo a passo.',
}

const en: AiReviewLabels = {
  pending: '{count} AI changes in the open document — the file has not been changed yet',
  pendingOne: '1 AI change in the open document — the file has not been changed yet',
  accept: 'Accept',
  reject: 'Reject',
  acceptTitle: "Keep the AI's changes (and save them when AutoSave is on)",
  rejectTitle: "Undo the AI's whole task",
  accepted: 'Changes accepted',
  rejected: 'Task undone',
  rolledBack: 'The task failed; its changes were undone',
  reverting: 'Undoing the task… the file is saved only once that is confirmed',
  failedKept:
    'The task failed. Its partial changes were not undone automatically; they stay here for you to decide.',
  conflictEdited:
    'You edited the document during or after the task. Rejecting would undo those edits too, so it is not available; accept, or use Undo (Ctrl+Z) step by step.',
  conflictDisk:
    'The file changed on disk after the task. Rejecting is not safe; accept or reopen the file.',
  conflictUntracked:
    'There is not enough history to undo this task in one step. Accept it, or close the file without saving to discard it.',
  openTitle: 'AI changes waiting for a decision',
  undoTask: 'Undo task',
  undoTaskTitle: 'Undo all the changes of this accepted task at once',
  undone: 'Task accepted, then undone',
  undoUnavailable:
    'This task can no longer be undone in one step: the document changed after it or there is not enough history. Use Undo (Ctrl+Z) step by step.',
}

const es: AiReviewLabels = {
  pending:
    '{count} cambios de la IA en el documento abierto — el archivo todavía no se ha modificado',
  pendingOne: '1 cambio de la IA en el documento abierto — el archivo todavía no se ha modificado',
  accept: 'Aceptar',
  reject: 'Rechazar',
  acceptTitle: 'Conservar los cambios de la IA (y guardarlos con el guardado automático activado)',
  rejectTitle: 'Deshacer toda la tarea de la IA',
  accepted: 'Cambios aceptados',
  rejected: 'Tarea deshecha',
  rolledBack: 'La tarea falló; sus cambios se deshicieron',
  reverting: 'Deshaciendo la tarea… el archivo solo se guarda una vez confirmado',
  failedKept:
    'La tarea falló. Sus cambios parciales no se deshicieron automáticamente; quedan aquí para que decidas.',
  conflictEdited:
    'Editaste el documento durante o después de la tarea. Rechazar desharía también esas ediciones, así que no está disponible; acepta o usa Deshacer (Ctrl+Z) paso a paso.',
  conflictDisk:
    'El archivo cambió en el disco después de la tarea. Rechazar no es seguro; acepta o vuelve a abrir el archivo.',
  conflictUntracked:
    'No hay historial suficiente para deshacer esta tarea de una vez. Acéptala, o cierra el archivo sin guardar para descartarla.',
  openTitle: 'Cambios de la IA pendientes de decisión',
  undoTask: 'Deshacer tarea',
  undoTaskTitle: 'Deshacer de una vez todos los cambios de esta tarea aceptada',
  undone: 'Tarea aceptada y luego deshecha',
  undoUnavailable:
    'Esta tarea ya no se puede deshacer de una vez: el documento cambió después de ella o no hay historial suficiente. Usa Deshacer (Ctrl+Z) paso a paso.',
}

/** Portuguese and Spanish for the Fariv audience; every other interface language reads English. */
export const AI_REVIEW_LABELS: Partial<Record<Lang, AiReviewLabels>> & { en: AiReviewLabels } = {
  pt,
  en,
  es,
}

export function aiReviewLabels(lang: Lang | string): AiReviewLabels {
  return AI_REVIEW_LABELS[lang as Lang] ?? AI_REVIEW_LABELS.en
}
