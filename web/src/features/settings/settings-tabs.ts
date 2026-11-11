import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router'

// The settings page's topic tabs, in the order they show. One subject has one
// home: what gets recorded, what AI may do, the clients, the connections out
// of this computer, and the system itself.
export const SETTINGS_TABS = ['recording', 'ai', 'clients', 'connections', 'system'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'recording'

export const settingsTabFrom = (value: unknown): SettingsTab =>
  SETTINGS_TABS.find(tab => tab === value) ?? DEFAULT_SETTINGS_TAB

// The tabs of the settings page before the regrouping (2026-11). Links outside
// the console still name them: the server's update notice (?tab=version), saved
// bookmarks and older docs. Can go once no shipped link names them.
const RENAMED_TABS: Readonly<Record<string, { tab: SettingsTab, hash?: string }>> = {
  memory: { tab: 'recording' },
  network: { tab: 'connections' },
  version: { tab: 'system', hash: '#version' },
}

/** Where an old /settings?tab= link now points, or true when it already names a current tab. */
export function renamedSettingsTab(to: RouteLocationNormalized): RouteLocationRaw | true {
  const renamed = typeof to.query.tab === 'string' ? RENAMED_TABS[to.query.tab] : undefined
  if (!renamed) return true
  return { path: to.path, query: { ...to.query, tab: renamed.tab }, hash: renamed.hash ?? to.hash, replace: true }
}
