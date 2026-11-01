import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

const HIDDEN = 'data-search-hidden'
const CARD = '.settings-card'
const normalize = (text: string | null | undefined) => (text ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Filter the settings page in place by what it already shows. A card stays
 * when any of its text matches; inside a card whose title does not match,
 * only the matching rows stay. Returns how many cards match.
 */
export function filterSettings(root: HTMLElement, query: string): number {
  const needle = normalize(query)
  let matches = 0
  for (const card of root.querySelectorAll<HTMLElement>(CARD)) {
    const rows = [...card.querySelectorAll<HTMLElement>('.setting-row')]
    if (!needle) {
      card.removeAttribute(HIDDEN)
      for (const row of rows) row.removeAttribute(HIDDEN)
      matches += 1
      continue
    }
    const found = normalize(card.textContent).includes(needle)
    card.toggleAttribute(HIDDEN, !found)
    if (!found) continue
    matches += 1
    const title = normalize(card.querySelector('[data-slot="card-title"], h2, h3')?.textContent)
    const rowMatches = rows.filter(row => normalize(row.textContent).includes(needle))
    // A title match or a match outside every row keeps the whole card readable.
    const keepAll = title.includes(needle) || rowMatches.length === 0
    for (const row of rows) row.toggleAttribute(HIDDEN, !keepAll && !rowMatches.includes(row))
  }
  return matches
}

/**
 * The card a link points at: with a #hash, the card holding the element it
 * names; without one, the first card a ?setting= search left visible.
 */
export function linkedCard(root: HTMLElement, hash: string): HTMLElement | null {
  const id = hash.replace(/^#/, '')
  if (!id) return root.querySelector<HTMLElement>(`${CARD}:not([${HIDDEN}])`)
  const named = root.ownerDocument.getElementById(id)
  return named && root.contains(named) ? named.closest<HTMLElement>(CARD) : null
}

/** Keep the filter applied while the query changes and cards load their content. */
export function useSettingsSearch(root: Ref<HTMLElement | null>, query: Ref<string>, onCount: (count: number) => void) {
  const apply = () => { if (root.value) onCount(filterSettings(root.value, query.value)) }
  // Only content changes re-run it; the filter's own attribute writes are not observed.
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { if (query.value) apply() })
  watch(query, apply)
  watch(root, element => {
    observer?.disconnect()
    if (element) { observer?.observe(element, { childList: true, subtree: true, characterData: true }); apply() }
  })
  onMounted(apply)
  onBeforeUnmount(() => observer?.disconnect())
}

// Setting keys used in links (the Agent's explain_settings) mapped to the label
// the page shows, so a link filters the page in the person's own language.
const SETTING_LABELS: Record<string, string> = {
  capture: 'settings.behavior.capture',
  notifications: 'settings.notifications.title',
  agentNamingStyle: 'settings.agentNaming.title',
  topicPromotion: 'settings.topicPromotion.title',
  refresh: 'settings.resources.refresh',
  launchers: 'settings.conversationLaunchers.title',
  lanAccess: 'settings.behavior.lanAccess',
  ports: 'settings.ports.title',
  runtimeMode: 'settings.behavior.runtimeMode',
  // The desktop client's tray 「导出诊断包…」 opens ?tab=system&setting=diagnostics.
  diagnostics: 'settings.diagnostics.title',
}

export function settingSearchTerm(key: unknown, translate: (key: string) => string): string {
  return typeof key === 'string' && SETTING_LABELS[key] ? translate(SETTING_LABELS[key]) : ''
}
