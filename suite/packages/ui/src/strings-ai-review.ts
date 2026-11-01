import type { Lang } from '@genoffice/i18n'

/** Labels of the Fariv review card under an AI task (all three editors). */
export interface AiReviewLabels {
  /** pending: `{count}` changes wait for a decision; the file is untouched */
  pending: string
  /** pending with a single change */
  pendingOne: string
  accept: string
  reject: string
  acceptTitle: string
  rejectTitle: string
  accepted: string
  rejected: string
  /** a failed run whose partial changes were undone */
  rolledBack: string
  /** the document changed after the task: rejecting would undo those changes too */
  conflictEdited: string
  /** the file changed on disk after the task */
  conflictDisk: string
  /** the editor kept no undo record of the task */
  conflictUntracked: string
  /** the task is still running: changes go to the draft only */
  running: string
}

const pt: AiReviewLabels = {
  pending: '{count} alterações em revisão — o arquivo ainda não foi alterado',
  pendingOne: '1 alteração em revisão — o arquivo ainda não foi alterado',
  accept: 'Aceitar',
  reject: 'Rejeitar',
  acceptTitle: 'Manter as alterações da IA (e salvar, com o salvamento automático ligado)',
  rejectTitle: 'Desfazer a tarefa inteira da IA',
  accepted: 'Alterações aceitas',
  rejected: 'Tarefa desfeita',
  rolledBack: 'A tarefa falhou; as alterações parciais foram desfeitas',
  conflictEdited:
    'O documento mudou depois da tarefa. Rejeitar desfaria também essas mudanças; aceite ou use Desfazer (Ctrl+Z) passo a passo.',
  conflictDisk:
    'O arquivo mudou no disco depois da tarefa. Rejeitar não é seguro; aceite ou reabra o arquivo.',
  conflictUntracked:
    'Esta tarefa é grande demais para desfazer de uma vez. Aceite, ou feche o arquivo sem salvar para descartá-la.',
  running: 'A IA está trabalhando no rascunho',
}

const en: AiReviewLabels = {
  pending: '{count} changes to review — the file has not been changed yet',
  pendingOne: '1 change to review — the file has not been changed yet',
  accept: 'Accept',
  reject: 'Reject',
  acceptTitle: "Keep the AI's changes (and save them when AutoSave is on)",
  rejectTitle: "Undo the AI's whole task",
  accepted: 'Changes accepted',
  rejected: 'Task undone',
  rolledBack: 'The task failed; its partial changes were undone',
  conflictEdited:
    'The document changed after the task. Rejecting would undo those changes too; accept, or use Undo (Ctrl+Z) step by step.',
  conflictDisk:
    'The file changed on disk after the task. Rejecting is not safe; accept or reopen the file.',
  conflictUntracked:
    'This task is too large to undo in one step. Accept it, or close the file without saving to discard it.',
  running: 'The AI is working on the draft',
}

const es: AiReviewLabels = {
  pending: '{count} cambios en revisión — el archivo todavía no se ha modificado',
  pendingOne: '1 cambio en revisión — el archivo todavía no se ha modificado',
  accept: 'Aceptar',
  reject: 'Rechazar',
  acceptTitle: 'Conservar los cambios de la IA (y guardarlos con el guardado automático activado)',
  rejectTitle: 'Deshacer toda la tarea de la IA',
  accepted: 'Cambios aceptados',
  rejected: 'Tarea deshecha',
  rolledBack: 'La tarea falló; se deshicieron sus cambios parciales',
  conflictEdited:
    'El documento cambió después de la tarea. Rechazar también desharía esos cambios; acepta o usa Deshacer (Ctrl+Z) paso a paso.',
  conflictDisk:
    'El archivo cambió en el disco después de la tarea. Rechazar no es seguro; acepta o vuelve a abrir el archivo.',
  conflictUntracked:
    'Esta tarea es demasiado grande para deshacerla de una vez. Acéptala, o cierra el archivo sin guardar para descartarla.',
  running: 'La IA está trabajando en el borrador',
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
