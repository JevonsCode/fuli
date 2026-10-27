import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn(), deleteJson: vi.fn() }))
vi.mock('@/api/client', () => api)

import { messages } from '@/i18n'
import { useOccupationCatalog } from '@/features/occupations/occupation-catalog'
import { syntheticOccupations } from '@/test-support/occupation-fixtures'
import { occupationLabels } from './agent-occupation'
import providerCatalog from '../../../../graph-provider/fuli_graph/occupation_catalog.py?raw'

describe('occupationLabels', () => {
  it('names a built-in by its shipped name and anything else as custom until the catalog is read, never by its key', () => {
    expect(occupationLabels({ role: 'management', tags: ['lead', 'assistant'], updatedAt: '2026-10-17T00:00:00Z' }))
      .toEqual(['管理', '负责人', '助手'])
    expect(occupationLabels({ role: 'hr', tags: ['custom_0123456789abcdef'], updatedAt: '2026-10-27T00:00:00Z' }))
      .toEqual(['Agent 资源', '自定义职业'])
  })

  it('shows the catalog name once the space catalog is read, main role first without repeating it', async () => {
    api.getJson.mockResolvedValue(syntheticOccupations([['engineering', '工程师（本空间）'], ['custom_synthetic', '合成职业']]))
    await useOccupationCatalog(ref('space-labels')).load()
    await flushPromises()
    expect(occupationLabels({ role: 'engineering', tags: ['custom_synthetic', 'engineering'], updatedAt: '2026-10-17T00:00:00Z' }))
      .toEqual(['工程师（本空间）', '合成职业'])
  })

  it('shows nothing for an Agent nobody has classified', () => {
    expect(occupationLabels(null)).toEqual([])
    expect(occupationLabels(undefined)).toEqual([])
    expect(occupationLabels({ role: null, tags: [], updatedAt: '2026-10-17T00:00:00Z' })).toEqual([])
  })

  it('ships the same built-in names as the graph provider catalog', () => {
    const shipped = [...providerCatalog.matchAll(/^\s+\('([a-z_]+)', '([^']+)', '([^']+)',/gm)]
    expect(shipped.length).toBeGreaterThan(20)
    expect(Object.fromEntries(shipped.map(([, key, zh]) => [key, zh]))).toEqual(messages['zh-CN'].occupations.builtinNames)
    expect(Object.fromEntries(shipped.map(([, key, , en]) => [key, en]))).toEqual(messages['en-US'].occupations.builtinNames)
  })
})
