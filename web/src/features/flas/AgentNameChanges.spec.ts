import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

const { default: AgentNameChanges } = await import('./AgentNameChanges.vue')

// Synthetic renames as the console answers GET /api/project-agent-name-changes.
const renamed = (agentId: string, displayName: string, name: string, keptByName: string, gaveWay: string,
  until = '2026-11-23T00:00:00Z') => ({ agentId, displayName, status: 'active', keptByName,
  change: { name, until, reason: 'duplicate_name', keptByAgentId: 'kept', gaveWay } })

async function show() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  const wrapper = mount(AgentNameChanges, { props: { personalSpaceId: 'space-a' }, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

afterEach(() => localStorage.clear())

describe('AgentNameChanges', () => {
  it('says how many FLAs were renamed and lists each with its 原名, why, and a link to its page', async () => {
    getJson.mockResolvedValue([renamed('morgan-b', 'Lyra Lane', 'Morgan Vale', 'Morgan Vale', 'less_recent'),
      renamed('emery-c', 'Nora Hill', 'Emery Fox', 'Emery Fox', 'test')])
    const wrapper = await show()
    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agent-name-changes?personalSpaceId=space-a')
    expect(wrapper.get('[data-flas-renamed] p').text()).toBe('有 2 位 FLA 和别人重名，已换了新名字。')
    await wrapper.get('[data-flas-renamed-toggle]').trigger('click')
    const items = wrapper.findAll('[data-flas-renamed-item]')
    expect(items.map(item => item.text())).toEqual([
      'Lyra Lane原名 Morgan Vale · Morgan Vale 最近更活跃', 'Nora Hill原名 Emery Fox · 测试用 FLA，名字留给了 Emery Fox'])
    expect(items[0]!.get('a').attributes('href')).toContain('morgan-b')
  })

  it('知道了 hides it in this browser until another rename happens; nothing shows when there is none', async () => {
    getJson.mockResolvedValue([renamed('morgan-b', 'Lyra Lane', 'Morgan Vale', 'Morgan Vale', 'less_work')])
    const first = await show()
    await first.get('[data-flas-renamed-dismiss]').trigger('click')
    expect(first.find('[data-flas-renamed]').exists()).toBe(false)
    expect((await show()).find('[data-flas-renamed]').exists()).toBe(false)
    getJson.mockResolvedValue([renamed('morgan-b', 'Lyra Lane', 'Morgan Vale', 'Morgan Vale', 'less_work'),
      renamed('casey-b', 'Iris Reed', 'Casey Hayes', 'Casey Hayes', 'later', '2026-11-24T00:00:00Z')])
    expect((await show()).get('[data-flas-renamed] p').text()).toContain('2 位')
    getJson.mockResolvedValue([])
    expect((await show()).find('[data-flas-renamed]').exists()).toBe(false)
  })

  it('shows nothing when the list cannot be read; each FLA\'s page still says its 原名', async () => {
    getJson.mockImplementation(async () => { throw new Error('offline') })
    expect((await show()).find('[data-flas-renamed]').exists()).toBe(false)
  })
})
