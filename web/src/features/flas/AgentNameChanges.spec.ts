import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson, putJson }))

const { default: AgentNameChanges } = await import('./AgentNameChanges.vue')

// Synthetic renames as the console answers GET /api/project-agent-name-changes.
const renamed = (agentId: string, displayName: string, name: string, keptByName: string | null, gaveWay: string | null,
  until = '2026-11-23T00:00:00Z', reason = 'duplicate_name') => ({ agentId, displayName, status: 'active', keptByName,
  change: { name, until, reason, keptByAgentId: keptByName ? 'kept' : null, gaveWay } })
const answer = (items: object[], seenUntil: string | null = null) => ({ items, seenUntil })

async function show() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  const wrapper = mount(AgentNameChanges, { props: { personalSpaceId: 'space-a' }, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

afterEach(() => { getJson.mockReset(); putJson.mockReset() })

describe('AgentNameChanges', () => {
  it('announces settled names once, each with its 原名, why and a link to its page', async () => {
    getJson.mockResolvedValue(answer([renamed('morgan-b', 'Lyra Lane', 'Morgan Vale', 'Morgan Vale', 'less_recent'),
      renamed('quinn-lead', 'Nora Hill', 'Quinn Shaw', 'Quinn Shaw', 'temporary_lead')]))
    const wrapper = await show()
    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agent-name-changes?personalSpaceId=space-a')
    expect(wrapper.get('[data-flas-renamed] p').text()).toBe('有 2 位 FLA 换了新名字。')
    await wrapper.get('[data-flas-renamed-toggle]').trigger('click')
    expect(wrapper.findAll('[data-flas-renamed-item]').map(item => item.text())).toEqual([
      'Lyra Lane原名 Morgan Vale · Morgan Vale 最近更活跃', 'Nora Hill原名 Quinn Shaw · 只在临时项目工作，名字留给 Quinn Shaw'])
    expect(wrapper.get('[data-flas-renamed-item] a').attributes('href')).toContain('morgan-b')
  })

  it('知道了 is kept by the console for every browser, and 改名记录 still lists every rename', async () => {
    const items = [renamed('morgan-b', 'Lyra Lane', 'Morgan Vale', 'Morgan Vale', 'less_work', '2026-11-23T00:00:00Z'),
      renamed('iris', 'Iris Vale', 'PPT 专责', null, null, '2026-11-20T00:00:00Z', 'renamed')]
    getJson.mockResolvedValue(answer(items))
    putJson.mockResolvedValue(answer(items, '2026-11-23T00:00:00Z'))
    const wrapper = await show()
    await wrapper.get('[data-flas-renamed-dismiss]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agent-name-changes/seen',
      { personalSpaceId: 'space-a', until: '2026-11-23T00:00:00Z' }, expect.anything())
    expect(wrapper.find('[data-flas-renamed]').exists()).toBe(false)
    await wrapper.get('[data-flas-renamed-history]').trigger('click')
    expect(wrapper.get('[data-flas-renamed-history]').text()).toBe('改名记录（2）')
    expect(wrapper.findAll('[data-flas-renamed-item]').map(item => item.text())).toEqual([
      'Lyra Lane原名 Morgan Vale · Morgan Vale 做的事更多', 'Iris Vale原名 PPT 专责 · 你改的'])
  })

  it('a person\'s own rename is never announced, and nothing shows when there is none or the read fails', async () => {
    getJson.mockResolvedValue(answer([renamed('iris', 'Iris Vale', 'PPT 专责', null, null, '2026-11-20T00:00:00Z', 'renamed')]))
    expect((await show()).find('[data-flas-renamed]').exists()).toBe(false)
    getJson.mockResolvedValue(answer([]))
    expect((await show()).html()).not.toContain('data-flas-renamed')
    getJson.mockRejectedValue(new Error('offline'))
    expect((await show()).html()).not.toContain('data-flas-renamed')
  })
})
