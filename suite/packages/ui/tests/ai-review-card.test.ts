// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import {
  acceptReview,
  confirmRevert,
  finishRun,
  noteAiChange,
  rejectReview,
  startReview,
  type ReviewTask,
} from '@genoffice/agent-core'
import { AiOpenReviews, AiReviewCard } from '../src/AiReviewCard'
import { aiReviewLabels } from '../src/strings-ai-review'

function render(node: ReactElement): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => createRoot(host).render(node))
  return host
}

function card(task: ReviewTask<unknown>, lang = 'pt', onAccept = () => {}, onReject = () => {}) {
  return render(createElement(AiReviewCard, { task, lang, onAccept, onReject }))
}

const ran = (count: number) =>
  noteAiChange(startReview<number>('t', 1), { before: 1, after: 2, count })
const pending = finishRun(ran(3), { after: 2 }).task

describe('AiReviewCard', () => {
  it('offers accept and reject for a pending task, in Portuguese', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const host = card(pending, 'pt', onAccept, onReject)
    expect(host.textContent).toContain('3 alterações da IA no documento aberto')
    expect(host.querySelector('[data-task]')!.getAttribute('data-task')).toBe('t')
    const [accept, reject] = host.querySelectorAll('button')
    expect(accept!.textContent).toBe('Aceitar')
    expect(reject!.textContent).toBe('Rejeitar')
    act(() => accept!.click())
    act(() => reject!.click())
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onReject).toHaveBeenCalledOnce()
  })

  it('says a single change in the singular', () => {
    expect(card(finishRun(ran(1), { after: 2 }).task).textContent).toContain(
      '1 alteração da IA no documento aberto',
    )
  })

  it('disables reject and explains the conflict', () => {
    const host = card(rejectReview(pending, 99).task)
    expect(host.querySelector('[data-review]')!.getAttribute('data-review')).toBe('conflict-edited')
    expect(host.querySelector<HTMLButtonElement>('.ai-review-reject')!.disabled).toBe(true)
    expect(host.textContent).toContain('edições suas durante ou depois da tarefa')
  })

  it('a failed run kept under review says so, and that it was not undone', () => {
    const failed = finishRun(ran(2), { after: 7, error: 'boom' }).task
    const host = card(failed)
    expect(host.querySelector('[data-review]')!.getAttribute('data-review')).toBe('conflict-edited')
    expect(host.textContent).toContain('não foram desfeitas automaticamente')
  })

  it('never claims an undo that was not confirmed', () => {
    const reverting = finishRun(ran(2), { after: 2, error: 'boom' }).task
    const during = card(reverting)
    expect(during.querySelector('[data-review]')!.getAttribute('data-review')).toBe('reverting')
    expect(during.textContent).toContain('só é salvo depois de confirmado')
    expect(during.querySelectorAll('button')).toHaveLength(0)
    const unconfirmed = card(confirmRevert(reverting, false))
    expect(unconfirmed.textContent).not.toContain('as alterações dela foram desfeitas')
    expect(unconfirmed.textContent).toContain('Não há histórico suficiente')
    expect(card(confirmRevert(reverting, true)).textContent).toContain(
      'as alterações dela foram desfeitas',
    )
  })

  it('renders nothing while running or for a task without changes', () => {
    expect(card(startReview('r', 0), 'en').innerHTML).toBe('')
    expect(card(finishRun(startReview('e', 0), { after: 0 }).task, 'en').innerHTML).toBe('')
  })

  it('falls back to English for other interface languages', () => {
    expect(aiReviewLabels('ja')).toBe(aiReviewLabels('en'))
    expect(aiReviewLabels('pt').accept).toBe('Aceitar')
  })
})

describe('AiOpenReviews', () => {
  it('lists only the tasks still waiting for a decision', () => {
    const other = { ...pending, id: 'u' }
    const decided = acceptReview({ ...pending, id: 'd' }).task
    const onAccept = vi.fn()
    const host = render(
      createElement(AiOpenReviews, {
        tasks: [pending, other, decided],
        lang: 'pt',
        onAccept,
        onReject: () => {},
      }),
    )
    expect(host.textContent).toContain('Alterações da IA aguardando decisão')
    const cards = host.querySelectorAll('.ai-review-card')
    expect([...cards].map((c) => c.getAttribute('data-task'))).toEqual(['t', 'u'])
    act(() => cards[1]!.querySelector<HTMLButtonElement>('.ai-review-accept')!.click())
    expect(onAccept).toHaveBeenCalledWith('u')
    const none = render(
      createElement(AiOpenReviews, { tasks: [decided], lang: 'pt', onAccept, onReject: () => {} }),
    )
    expect(none.innerHTML).toBe('')
  })
})
