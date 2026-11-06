import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FlaOccupationKit from './FlaOccupationKit.vue'
import type { OccupationKit } from '@/features/occupation-kits/occupation-kits'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, putJson }))

// A synthetic kit only.
const reference = (id: string, enabled: boolean | null) => ({ id, name: `Synthetic ${id}`, url: `https://github.com/synthetic/kit/tree/${'a'.repeat(40)}/${id}`,
  license: 'MIT', summary: `Synthetic summary ${id}`, enabled })
const kit = (overrides: Partial<OccupationKit> = {}): OccupationKit => ({
  occupation: 'testing',
  plugin: { id: 'testing', version: '1.0.0', role: { name: 'qa-expert', url: `https://github.com/synthetic/roles/blob/${'a'.repeat(40)}/qa.md` } },
  checklist: { items: ['one', 'two'], from: { source: 'synthetic-roles', url: 'https://github.com/synthetic/roles', license: 'MIT' } },
  acceptance: { items: ['three'], from: { source: 'synthetic-roles', url: 'https://github.com/synthetic/roles', license: 'MIT' } },
  skills: [reference('skill-a', null), reference('skill-b', null)],
  mcpServers: [reference('mcp-a', null)],
  choice: null,
  ...overrides,
})
const mounted: Array<{ unmount: () => void }> = []
const render = () => {
  const wrapper = mount(FlaOccupationKit, { props: { spaceId: 'space-a', agentId: 'fla-1', agentName: 'Lumen' } })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => { setActivePinia(createPinia()); getJson.mockReset(); putJson.mockReset() })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('起步包', () => {
  it('shows where the kit came from and asks nothing until a recommendation is clicked', async () => {
    getJson.mockResolvedValue(kit())
    const wrapper = render()
    await flushPromises()
    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agents/fla-1/occupation-kit?personalSpaceId=space-a')
    expect(wrapper.get('[data-kit-source]').text()).toBe('synthetic/roles · MIT')
    expect(wrapper.text()).toContain('干活清单 2 条 · 验收 1 条')
    expect(wrapper.find('[data-kit-unanswered]').exists()).toBe(true)
    expect(wrapper.text()).toContain('MCP（只是建议，不会自动连接）')
  })

  it('turns one recommendation on with one click and keeps the others as they were', async () => {
    getJson.mockResolvedValue(kit({ skills: [reference('skill-a', false), reference('skill-b', true)], mcpServers: [reference('mcp-a', false)],
      choice: { pluginVersion: '1.0.0', at: '2026-11-06T08:00:00Z', outdated: false } }))
    putJson.mockResolvedValue(kit({ skills: [reference('skill-a', true), reference('skill-b', true)], mcpServers: [reference('mcp-a', false)],
      choice: { pluginVersion: '1.0.0', at: '2026-11-06T08:01:00Z', outdated: false } }))
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-kit-item="skill-a"]').trigger('click')
    await flushPromises()
    expect(putJson.mock.calls[0]).toEqual(['/api/project-agents/fla-1/occupation-kit',
      { personalSpaceId: 'space-a', skills: ['skill-a', 'skill-b'], mcpServers: [] }, expect.anything()])
    expect(wrapper.get('[data-kit-item="skill-a"]').attributes('aria-pressed')).toBe('true')
  })

  it('an occupation without a kit shows nothing', async () => {
    getJson.mockResolvedValue({ occupation: 'legal', plugin: null })
    const wrapper = render()
    await flushPromises()
    expect(wrapper.find('[data-widget="fla-kit"]').exists()).toBe(false)
  })
})
