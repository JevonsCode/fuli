import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, resolveLayout } from './layout'

describe('widget layout', () => {
  it('uses the code default when nothing is saved', () => {
    expect(resolveLayout(null)).toEqual(DEFAULT_LAYOUT)
  })

  it('moves a widget by data alone, and keeps defaults for slots a saved layout leaves out', () => {
    const moved = resolveLayout({ 'fla.overview': ['team-cards'] })
    expect(moved['fla.overview']).toEqual(['team-cards'])
    expect(moved['shell.aboveDock']).toEqual(['team-island'])
    expect(moved['fla.profile']).toEqual(['fla-growth', 'fla-kit'])
  })

  it('reads the FLA page in the order people ask: work first, configuration last (docs/fla-page.md)', () => {
    const { 'fla.overview': work, 'fla.history': history, 'fla.profile': profile } = resolveLayout(null)
    expect(work).toEqual(['fla-blocked', 'fla-sheets'])
    expect(history).toEqual(['fla-work-locations', 'fla-activity', 'workstream-ledger'])
    expect(profile.at(-1)).toBe('fla-kit')
  })

  it('drops unknown slots and widgets, widgets in a slot they were not built for, and repeats', () => {
    const resolved = resolveLayout({
      'workbench.feed': ['team-cards'],
      'fla.overview': ['nonsense', 'team-island', 'team-cards', 'team-cards'],
      'shell.aboveDock': 'not a list',
    })
    expect(Object.keys(resolved)).toEqual(['shell.aboveDock', 'fla.overview', 'fla.history', 'fla.profile'])
    expect(resolved['fla.overview']).toEqual(['team-cards'])
    expect(resolved['shell.aboveDock']).toEqual(['team-island'])
  })
})
