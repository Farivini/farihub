import type { TitleBarOverlay } from 'electron'

import { titleRowHeight } from '../shared/tab-drag-geometry'

/// Windows/Linux draw the caption buttons over the tab strip (titleBarStyle
/// 'hidden'); the overlay must match the strip's --tabstrip-bg / text tokens
/// in renderer/src/tabbar.css or the buttons sit on a visibly different band.
///
/// Its height has to follow the interface scale too (genoffice#1913): the strip is
/// `zoom`ed, so a 150% strip is 60px tall and a 40px overlay band would leave
/// the caption buttons floating over the document.

/// Fariv: the buttons sit on the title row only (TITLE_ROW_HEIGHT), whose colors are
/// --fariv-title-bg / --fariv-title-text in tabbar.css.
export function tabStripOverlay(dark: boolean, uiScale = 1): TitleBarOverlay {
  const height = titleRowHeight(uiScale)
  return dark
    ? { color: '#15161a', symbolColor: '#d6d7dc', height }
    : { color: '#f4f2ef', symbolColor: '#3a3b40', height }
}
