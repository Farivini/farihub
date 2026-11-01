import { describe, expect, it } from 'vitest'
import { deckFingerprint } from '../src/main/deck-fingerprint'

const text = (value: string) => new TextEncoder().encode(value)
const SLIDES = new Set(['ppt/slides/slide1.xml'])
const render = [{ elements: [{ runs: [{ text: 'Título' }] }] }]
const size = { cx: 1, cy: 1 }

function entries(notes: string, slideXml = '<p:sld/>', media = text('png')) {
  return new Map<string, Uint8Array>([
    ['ppt/slides/slide1.xml', text(slideXml)],
    ['ppt/notesSlides/notesSlide1.xml', text(notes)],
    ['ppt/media/image1.png', media],
  ])
}

describe('deckFingerprint (Fariv review marker)', () => {
  it('changes with the speaker notes, which the render slides do not show', () => {
    const media = text('png')
    expect(
      deckFingerprint(render, size, entries('<a:t>A</a:t>', undefined, media), SLIDES),
    ).not.toBe(deckFingerprint(render, size, entries('<a:t>B</a:t>', undefined, media), SLIDES))
  })

  it('ignores a save rewriting the slide part with the same content', () => {
    const media = text('png')
    expect(deckFingerprint(render, size, entries('n', '<p:sld/>', media), SLIDES)).toBe(
      deckFingerprint(render, size, entries('n', '<p:sld><!--baked--></p:sld>', media), SLIDES),
    )
  })

  it('tells a replaced picture by its bytes identity, and the render slides by content', () => {
    const same = text('png')
    expect(deckFingerprint(render, size, entries('n', undefined, same), SLIDES)).toBe(
      deckFingerprint(render, size, entries('n', undefined, same), SLIDES),
    )
    expect(deckFingerprint(render, size, entries('n', undefined, same), SLIDES)).not.toBe(
      deckFingerprint(render, size, entries('n', undefined, text('png')), SLIDES),
    )
    expect(deckFingerprint([], size, entries('n', undefined, same), SLIDES)).not.toBe(
      deckFingerprint(render, size, entries('n', undefined, same), SLIDES),
    )
  })
})
