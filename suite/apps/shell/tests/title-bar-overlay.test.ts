import { describe, expect, it } from 'vitest'

import { tabStripOverlay } from '../src/main/title-bar-overlay'
import {
  TAB_ROW_HEIGHT,
  TAB_STRIP_HEIGHT,
  TITLE_ROW_HEIGHT,
  titleRowHeight,
} from '../src/shared/tab-drag-geometry'

describe('tabStripOverlay', () => {
  it('matches the Fariv title row in both themes and its unscaled height', () => {
    expect(tabStripOverlay(false)).toEqual({
      color: '#f4f2ef',
      symbolColor: '#3a3b40',
      height: TITLE_ROW_HEIGHT,
    })
    expect(tabStripOverlay(true)).toEqual({
      color: '#15161a',
      symbolColor: '#d6d7dc',
      height: TITLE_ROW_HEIGHT,
    })
    // the caption buttons cover the title row only; editors start below both rows
    expect(TAB_STRIP_HEIGHT).toBe(TITLE_ROW_HEIGHT + TAB_ROW_HEIGHT)
  })

  it('grows the caption band with the interface scale', () => {
    // The chrome is `zoom`ed by `--ui-scale` (genoffice#1913); a fixed band would leave
    // the buttons misplaced once the interface is enlarged.
    expect(tabStripOverlay(false, 1.5).height).toBe(Math.round(TITLE_ROW_HEIGHT * 1.5))
    expect(tabStripOverlay(true, 1.5).height).toBe(titleRowHeight(1.5))
    expect(tabStripOverlay(false, 1.5).height).toBe(tabStripOverlay(true, 1.5).height)
  })

  it('defaults to unscaled so an old call site keeps its band', () => {
    expect(tabStripOverlay(false).height).toBe(tabStripOverlay(false, 1).height)
  })
})
