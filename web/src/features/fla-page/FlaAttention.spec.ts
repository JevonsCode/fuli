import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import FlaAttention from './FlaAttention.vue'
import { forgetAgentGrowth } from './agent-growth'
import type { Waiting } from './fla-now'
import { forgetFlaKits } from './kit-read'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic kit and experiences only.
const reference = (id: string, enabled: boolean | null) => ({ id, name: `Synthetic ${id}`, url: 'https://example.test/kit', license: 'MIT', summary: 'Synthetic', enabled })
const kit = (choice: unknown, skills = [reference('skill-a', null), reference('skill-b', null)]) => ({ occupation: 'testing',
  plugin: { id: 'testing', version: '1.0.0', role: { name: 'Synthetic role', url: 'https://example.test/role' } }, skills, mcpServers: [reference('mcp-a', null)], choice })
const experience = (itemId: string, proven: boolean, status = 'pending') => ({ itemId, personalProjectId: 'p-1', title: `Synthetic ${itemId}`, solution: 'Synthetic',
  boundary: null, status, uses: 2, tasks: 2, lastUsedAt: null, proven, basis: null })

let answers: { kit: unknown; growth: unknown }
beforeEach(() => {
  forgetFlaKits(); forgetAgentGrowth(); getJson.mockReset()
  answers = { kit: { occupation: 'legal', plugin: null }, growth: { partial: false, counts: { total: 0, proven: 0, kept: 0 }, items: [] } }
  getJson.mockImplementation(async (url: string) => {
    if (url.includes('/occupation-kit?')) return answers.kit
    if (url.includes('/growth?')) return answers.growth
    throw new Error(`Unexpected request: ${url}`)
  })
})
afterEach(() => { forgetFlaKits(); forgetAgentGrowth() })

async function render(others: Waiting | null = null) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/agents/space-a/fla-1')
  const wrapper = mount(FlaAttention, { global: { plugins: [router] }, props: { spaceId: 'space-a', agentId: 'fla-1', others } })
  await flushPromises()
  return wrapper
}

describe('等你处理', () => {
  it('is not there at all when nothing waits on the person', async () => {
    const wrapper = await render()
    expect(wrapper.find('[data-fla-attention]').exists()).toBe(false)
  })

  it('says how many other tasks wait for a call and goes to the first of them', async () => {
    const wrapper = await render({ review: 2, blocked: 0, taskId: 't-2' })
    const row = wrapper.get('[data-attention="tasks"]')
    expect(row.text()).toBe('另有 2 件等你拍板')
    expect(row.attributes('href')).toBe('/agents/space-a/fla-1?task=t-2')
    expect((await render({ review: 1, blocked: 2, taskId: 't-3' })).get('[data-attention="tasks"]').text()).toBe('另有 1 件等你拍板、2 件被卡住')
  })

  it('says how many starter kit picks are still owed and goes to the kit', async () => {
    answers.kit = kit(null)
    const wrapper = await render()
    const row = wrapper.get('[data-attention="kit"]')
    expect(row.text()).toBe('起步包还有 3 项等你选')
    await row.trigger('click')
    expect(wrapper.emitted('reveal')).toEqual([['fla-kit']])
  })

  it('names a kit updated after the choice, and nothing once every pick is answered', async () => {
    const answered = (outdated: boolean) => ({ ...kit({ pluginVersion: outdated ? '0.9.0' : '1.0.0', at: '2026-11-06T08:00:00Z', outdated },
      [reference('skill-a', true)]), mcpServers: [reference('mcp-a', false)] })
    answers.kit = answered(true)
    expect((await render()).get('[data-attention="kit"]').text()).toBe('起步包更新了，等你再看一眼')
    forgetFlaKits()
    answers.kit = answered(false)
    expect((await render()).find('[data-attention="kit"]').exists()).toBe(false)
  })

  it('counts the experiences waiting to be kept or dropped, not the kept or unproven ones', async () => {
    answers.growth = { partial: false, counts: { total: 3, proven: 2, kept: 1 },
      items: [experience('a', true), experience('b', true, 'confirmed'), experience('c', false)] }
    const wrapper = await render()
    const row = wrapper.get('[data-attention="growth"]')
    expect(row.text()).toBe('1 条经验等你定留不留')
    await row.trigger('click')
    expect(wrapper.emitted('reveal')).toEqual([['fla-growth']])
  })
})
