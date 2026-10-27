import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

const HIDDEN = 'data-search-hidden'
const OPENED = 'data-search-opened'
const normalize = (text: string | null | undefined) => (text ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Filter the settings page in place by what it already shows. A card stays
 * when any of its text matches; inside a card whose title does not match,
 * only the matching rows stay. Collapsed cards open while they match and
 * close again when the search clears. Returns how many cards match.
 */
export function filterSettings(root: HTMLElement, query: string): number {
  const needle = normalize(query)
  let matches = 0
  for (const card of root.querySelectorAll<HTMLElement>('.settings-card')) {
    const rows = [...card.querySelectorAll<HTMLElement>('.setting-row')]
    const details = card instanceof HTMLDetailsElement ? card : null
    if (!needle) {
      card.removeAttribute(HIDDEN)
      for (const row of rows) row.removeAttribute(HIDDEN)
      if (details?.hasAttribute(OPENED)) { details.open = false; details.removeAttribute(OPENED) }
      matches += 1
      continue
    }
    const found = normalize(card.textContent).includes(needle)
    card.toggleAttribute(HIDDEN, !found)
    if (!found) continue
    matches += 1
    const title = normalize(card.querySelector('summary, h3')?.textContent)
    const rowMatches = rows.filter(row => normalize(row.textContent).includes(needle))
    // A title match or a match outside every row keeps the whole card readable.
    const keepAll = title.includes(needle) || rowMatches.length === 0
    for (const row of rows) row.toggleAttribute(HIDDEN, !keepAll && !rowMatches.includes(row))
    if (details && !details.open) { details.open = true; details.setAttribute(OPENED, '') }
  }
  return matches
}

/**
 * The collapsed sections (marked data-settings-section) whose text holds the
 * query, so the page can open them while the search lasts. Closed sections
 * stay in the DOM, so their text is searchable.
 */
export function matchingSections(root: HTMLElement, query: string): string[] {
  const needle = normalize(query)
  if (!needle) return []
  return [...root.querySelectorAll<HTMLElement>('[data-settings-section]')]
    .filter(section => normalize(section.textContent).includes(needle))
    .map(section => section.dataset.settingsSection ?? '')
    .filter(Boolean)
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
  refresh: 'settings.resources.refresh',
  launchers: 'settings.conversationLaunchers.title',
  lanAccess: 'settings.behavior.lanAccess',
  ports: 'settings.ports.title',
  runtimeMode: 'settings.behavior.runtimeMode',
}

export function settingSearchTerm(key: unknown, translate: (key: string) => string): string {
  return typeof key === 'string' && SETTING_LABELS[key] ? translate(SETTING_LABELS[key]) : ''
}
