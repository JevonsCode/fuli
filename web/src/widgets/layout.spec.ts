import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, resolveLayout } from './layout'

describe('widget layout', () => {
  it('uses the code default when nothing is saved', () => {
    expect(resolveLayout(null)).toEqual(DEFAULT_LAYOUT)
  })

  it('moves a widget by data alone, and keeps defaults for slots a saved layout leaves out', () => {
    const moved = resolveLayout({ 'workbench.feed': [], 'fla.overview': ['team-cards'] })
    expect(moved['workbench.feed']).toEqual([])
    expect(moved['fla.overview']).toEqual(['team-cards'])
    expect(moved['shell.aboveDock']).toEqual(['team-island'])
  })

  it('drops unknown widgets, widgets in a slot they were not built for, and repeats', () => {
    const resolved = resolveLayout({
      'workbench.feed': ['nonsense', 'team-island', 'team-cards'],
      'fla.overview': ['team-cards'],
      'shell.aboveDock': 'not a list',
    })
    expect(resolved['workbench.feed']).toEqual(['team-cards'])
    expect(resolved['fla.overview']).toEqual([])
    expect(resolved['shell.aboveDock']).toEqual(['team-island'])
  })
})
