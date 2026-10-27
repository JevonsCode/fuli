import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn(), deleteJson: vi.fn() }))
vi.mock('@/api/client', () => api)

import { useOccupationCatalog } from '@/features/occupations/occupation-catalog'
import { SYNTHETIC_OCCUPATIONS } from '@/test-support/occupation-fixtures'
import { occupationLabels } from './agent-occupation'

describe('occupationLabels', () => {
  it('shows the key until the space catalog is read, then the catalog name', async () => {
    const occupation = { role: 'engineering', tags: ['testing', 'engineering'], updatedAt: '2026-10-17T00:00:00Z' }
    expect(occupationLabels(occupation)).toEqual(['engineering', 'testing'])
    api.getJson.mockResolvedValue(SYNTHETIC_OCCUPATIONS)
    await useOccupationCatalog(ref('space-labels')).load()
    await flushPromises()
    // Main role first, without repeating it among tags.
    expect(occupationLabels(occupation)).toEqual(['工程', '测试'])
    expect(occupationLabels({ role: 'hr', tags: [], updatedAt: '2026-10-27T00:00:00Z' })).toEqual(['Agent 资源'])
  })

  it('shows nothing for an Agent nobody has classified', () => {
    expect(occupationLabels(null)).toEqual([])
    expect(occupationLabels(undefined)).toEqual([])
    expect(occupationLabels({ role: null, tags: [], updatedAt: '2026-10-17T00:00:00Z' })).toEqual([])
  })
})
