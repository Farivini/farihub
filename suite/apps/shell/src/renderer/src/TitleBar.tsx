import { useEffect, useState } from 'react'
import type { TabSummary } from '../../shared/tabs-api'
import { useI18n } from './locale'

/**
 * Fariv title row: the wordmark on the left and, centred, the switcher between the three
 * spaces (Planilhas, Documentos, Apresentações). Picking a space goes to the most recently
 * used tab of that kind; with none open, it starts a new document of that kind. The window
 * caption buttons (Windows/Linux) and the app menu live on this row too.
 */
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

export type Space = 'sheets' | 'docs' | 'slides'
const SPACES: readonly Space[] = ['sheets', 'docs', 'slides']

/** Space labels: Portuguese first (the Fariv audience), English elsewhere. */
const LABELS: Record<'pt' | 'en' | 'es', Record<Space, string>> = {
  pt: { sheets: 'Planilhas', docs: 'Documentos', slides: 'Apresentações' },
  en: { sheets: 'Sheets', docs: 'Documents', slides: 'Presentations' },
  es: { sheets: 'Hojas de cálculo', docs: 'Documentos', slides: 'Presentaciones' },
}
const SWITCHER_LABEL = { pt: 'Espaço de trabalho', en: 'Workspace', es: 'Espacio de trabajo' }

function labelsFor(lang: string) {
  return lang === 'pt' || lang === 'es' ? lang : 'en'
}

/** Which tab a space switch lands on, or null when a new document has to be started. */
export function targetTab(tabs: readonly TabSummary[], space: Space, recent: readonly string[]): string | null {
  const ofKind = tabs.filter((tab) => tab.kind === space)
  if (ofKind.length === 0) return null
  const byRecency = recent.find((id) => ofKind.some((tab) => tab.id === id))
  return byRecency ?? ofKind[ofKind.length - 1].id
}

export function TitleBar() {
  const { lang, t } = useI18n()
  const which = labelsFor(lang)
  const [tabs, setTabs] = useState<TabSummary[]>([])
  // most recently active tab ids, newest first, to return to the last tab of a space
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    const apply = (next: TabSummary[]) => {
      setTabs(next)
      const active = next.find((tab) => tab.active)
      if (active) setRecent((ids) => [active.id, ...ids.filter((id) => id !== active.id)].slice(0, 50))
    }
    void window.aiOfficeTabs.list().then(apply)
    return window.aiOfficeTabs.onChanged(apply)
  }, [])

  const activeKind = tabs.find((tab) => tab.active)?.kind
  const go = (space: Space) => {
    const id = targetTab(tabs, space, recent)
    if (id) {
      void window.aiOfficeTabs.activate(id)
      return
    }
    if (space === 'sheets') void window.aiOffice.newSheet()
    else if (space === 'docs') void window.aiOffice.newDoc()
    else void window.aiOffice.newSlide()
  }

  return (
    <div className="fariv-title-row">
      <div className="tab-bar-drag-spacer" />
      {!IS_MAC && (
        <button
          className="tab-app-menu-btn"
          title={t('appMenu')}
          aria-label={t('appMenu')}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            void window.aiOfficeTabs.showAppMenu(Math.round(rect.left), Math.round(rect.bottom))
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <span className="fariv-wordmark" aria-label="Fariv">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 21L12 3l8 18" fill="none" stroke="var(--fariv-orange)" strokeWidth="2.8" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span>FARIV</span>
      </span>
      <div className="fariv-switcher" role="tablist" aria-label={SWITCHER_LABEL[which]} data-testid="space-switcher">
        {SPACES.map((space) => (
          <button
            key={space}
            role="tab"
            aria-selected={activeKind === space}
            className={`fariv-space ${activeKind === space ? 'active' : ''}`}
            data-space={space}
            onClick={() => go(space)}
          >
            {LABELS[which][space]}
          </button>
        ))}
      </div>
      <div className="tab-bar-caption-spacer" />
    </div>
  )
}
