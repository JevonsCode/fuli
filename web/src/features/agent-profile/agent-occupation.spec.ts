import { describe, expect, it } from 'vitest'
import { occupationLabels } from './agent-occupation'

describe('occupationLabels', () => {
  it('lists the main role first without repeating it among tags', () => {
    expect(occupationLabels({ role: 'engineering', tags: ['testing', 'engineering'], updatedAt: '2026-10-17T00:00:00Z' }))
      .toEqual(['开发', '测试'])
  })

  it('shows nothing for an Agent nobody has classified', () => {
    expect(occupationLabels(null)).toEqual([])
    expect(occupationLabels(undefined)).toEqual([])
    expect(occupationLabels({ role: null, tags: [], updatedAt: '2026-10-17T00:00:00Z' })).toEqual([])
  })
})
