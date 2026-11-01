import { createHash } from 'node:crypto'

/**
 * Fariv review marker of a deck: equal fingerprints mean equal content.
 *
 * It covers what the renderer shows (the render slides) and every package part outside
 * the slide parts — speaker notes, comments, media, theme… (archive-only edits do not
 * show in the render slides). The slide parts themselves are left out: a save rewrites
 * them with the same content (commitSaved bakes the patches), which must not read as a
 * change. XML parts are hashed by content; binary parts are never mutated in place, only
 * replaced wholesale (see session-state), so their identity stands for their content.
 */
const binaryIds = new WeakMap<Uint8Array, number>()
let nextBinaryId = 1

function binaryId(bytes: Uint8Array): number {
  let id = binaryIds.get(bytes)
  if (id === undefined) binaryIds.set(bytes, (id = nextBinaryId++))
  return id
}

export function deckFingerprint(
  renderSlides: unknown,
  size: unknown,
  entries: ReadonlyMap<string, Uint8Array>,
  slidePaths: ReadonlySet<string>,
): string {
  const hash = createHash('sha1')
  hash.update(JSON.stringify({ size, slides: renderSlides }))
  for (const path of [...entries.keys()].sort()) {
    if (slidePaths.has(path)) continue
    const bytes = entries.get(path)!
    hash.update(`\n${path}:`)
    if (/\.(xml|rels)$/i.test(path)) hash.update(bytes)
    else hash.update(`#${binaryId(bytes)}`)
  }
  return hash.digest('hex')
}
