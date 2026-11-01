// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { finishRun, recordChanges, rejectReview, startReview } from '@genoffice/agent-core'
import { AiReviewCard } from '../src/AiReviewCard'
import { aiReviewLabels } from '../src/strings-ai-review'

function render(node: ReactElement): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => createRoot(host).render(node))
  return host
}

const pending = finishRun(recordChanges(startReview('t', 1), 3), { after: 2 }).task

describe('AiReviewCard', () => {
  it('offers accept and reject for a pending task, in Portuguese', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    const host = render(
      createElement(AiReviewCard, {
        task: pending,
        lang: 'pt',
        onAccept: onAccept,
        onReject: onReject,
      }),
    )
    expect(host.textContent).toContain('3 alterações em revisão')
    const [accept, reject] = host.querySelectorAll('button')
    expect(accept!.textContent).toBe('Aceitar')
    expect(reject!.textContent).toBe('Rejeitar')
    act(() => accept!.click())
    act(() => reject!.click())
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onReject).toHaveBeenCalledOnce()
  })

  it('disables reject and explains the conflict', () => {
    const conflicted = rejectReview(pending, 99).task
    const host = render(
      createElement(AiReviewCard, {
        task: conflicted,
        lang: 'pt',
        onAccept: () => {},
        onReject: () => {},
      }),
    )
    expect(host.querySelector('[data-review]')!.getAttribute('data-review')).toBe('conflict-edited')
    expect(host.querySelector<HTMLButtonElement>('.ai-review-reject')!.disabled).toBe(true)
    expect(host.textContent).toContain('O documento mudou depois da tarefa')
  })

  it('renders nothing while running or for a task without changes', () => {
    const running = render(
      createElement(AiReviewCard, {
        task: startReview('r', 0),
        lang: 'en',
        onAccept: () => {},
        onReject: () => {},
      }),
    )
    expect(running.innerHTML).toBe('')
    const empty = finishRun(startReview('e', 0), { after: 0 }).task
    const host = render(
      createElement(AiReviewCard, {
        task: empty,
        lang: 'en',
        onAccept: () => {},
        onReject: () => {},
      }),
    )
    expect(host.innerHTML).toBe('')
  })

  it('says a single change in the singular', () => {
    const one = finishRun(recordChanges(startReview('o', 1), 1), { after: 2 }).task
    const host = render(
      createElement(AiReviewCard, {
        task: one,
        lang: 'pt',
        onAccept: () => {},
        onReject: () => {},
      }),
    )
    expect(host.textContent).toContain('1 alteração em revisão')
  })

  it('falls back to English for other interface languages', () => {
    expect(aiReviewLabels('ja')).toBe(aiReviewLabels('en'))
    expect(aiReviewLabels('pt').accept).toBe('Aceitar')
  })
})
