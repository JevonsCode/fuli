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
  })

  it('drops unknown slots and widgets, widgets in a slot they were not built for, and repeats', () => {
    const resolved = resolveLayout({
      'workbench.feed': ['team-cards'],
      'fla.overview': ['nonsense', 'team-island', 'team-cards', 'team-cards'],
      'shell.aboveDock': 'not a list',
    })
    expect(Object.keys(resolved)).toEqual(['shell.aboveDock', 'fla.overview'])
    expect(resolved['fla.overview']).toEqual(['team-cards'])
    expect(resolved['shell.aboveDock']).toEqual(['team-island'])
  })
})
