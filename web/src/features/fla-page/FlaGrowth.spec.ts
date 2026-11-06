import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import FlaGrowth from './FlaGrowth.vue'
import type { GrowthItem } from './agent-growth'

const { getJson, patchJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, patchJson }))

// Synthetic experiences only.
const item = (itemId: string, overrides: Partial<GrowthItem> = {}): GrowthItem => ({
  itemId, personalProjectId: 'app', title: `Synthetic approach ${itemId}`, solution: 'Run the focused suite first', boundary: null,
  status: 'pending', uses: 0, tasks: 0, lastUsedAt: null, proven: false,
  basis: { existence_reason: 'Reported at checkpoint', quadrant_reason: 'Observed', proposed_by: { kind: 'agent', label: 'lead-1' } },
  ...overrides,
})
const growth = (items: GrowthItem[]) => ({ partial: false, counts: { total: items.length, proven: items.filter(entry => entry.proven).length, kept: 0 }, items })
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
const mounted: Array<{ unmount: () => void }> = []
const render = () => {
  const wrapper = mount(FlaGrowth, { props: { spaceId: 'space-a', agentId: 'lead-1', agentName: 'Lumen', projectName: (id: string) => id }, global: { plugins: [router()] } })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => { setActivePinia(createPinia()); getJson.mockReset(); patchJson.mockReset() })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('学会了', () => {
  it('shows the proven experiences first with their use counts, three at a time', async () => {
    getJson.mockResolvedValue(growth([
      item('promoted', { status: 'agent_confirmed', uses: 4, tasks: 3, proven: true }),
      item('once', { uses: 1, tasks: 1 }), item('new'), item('kept', { status: 'confirmed', uses: 9, tasks: 5, proven: true })]))
    const wrapper = render()
    await flushPromises()
    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agents/lead-1/growth?personalSpaceId=space-a')
    const rows = wrapper.findAll('.growth-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain('用过 4 次 · 3 个任务')
    expect(rows[2]!.text()).toContain('还没用过')
    expect(wrapper.text()).toContain('1 条已在多个任务里用上，等你定留不留')
    await wrapper.get('.growth-more').trigger('click')
    expect(wrapper.findAll('.growth-row')).toHaveLength(4)
    expect(wrapper.findAll('.growth-row')[3]!.text()).toContain('人确认')
  })

  it('keeps one as the person\'s confirmation and drops another as outdated, with no second dialog', async () => {
    getJson.mockResolvedValue(growth([item('a', { status: 'agent_confirmed', uses: 3, tasks: 2, proven: true }), item('b')]))
    patchJson.mockResolvedValue({})
    const wrapper = render()
    await flushPromises()
    await wrapper.findAll('.growth-row')[0]!.findAll('button')[0]!.trigger('click')
    await flushPromises()
    expect(patchJson.mock.calls[0]![0]).toBe('/api/knowledge/entity/a')
    expect(patchJson.mock.calls[0]![1]).toMatchObject({ action: 'confirm', confirmationStatus: 'confirmed', personalProjectId: 'app',
      confirmationBasis: { existenceReason: 'Reported at checkpoint', confirmedBy: { kind: 'user' } } })
    expect(wrapper.findAll('.growth-row')[0]!.text()).toContain('人确认')
    await wrapper.findAll('.growth-row')[1]!.findAll('button')[1]!.trigger('click')
    await flushPromises()
    expect(patchJson.mock.calls[1]![1]).toMatchObject({ action: 'mark_outdated', personalSpaceId: 'space-a' })
    expect(wrapper.findAll('.growth-row')).toHaveLength(1)
  })

  it('says each verification state from the server evidence, never more', async () => {
    getJson.mockResolvedValue(growth([
      item('tested', { uses: 2, tasks: 2, proven: true, verification: { state: 'auto_verified', evidence: [
        { state: 'auto_verified', source: 'verification', ref: 'a1', refs: ['ci://synthetic/1', 'ci://synthetic/2'] },
        { state: 'ai_assessed', source: 'tonborg', ref: 'd1' }] } }),
      item('plain', { verification: { state: 'unverified', evidence: [] } }),
      item('older-server')]))
    const wrapper = render()
    await flushPromises()
    const [tested, plain, older] = wrapper.findAll('.growth-meta')
    expect(tested!.text()).toBe('用过 2 次 · 2 个任务 · 自动验证通过')
    expect(tested!.attributes('title')).toBe('测试证据 2 条 · Tonborg 验收通过')
    expect(plain!.text()).toBe('还没用过 · 尚未验证')
    expect(plain!.attributes('title')).toBeUndefined()
    expect(older!.text()).toBe('还没用过')
  })

  it('shows nothing when the FLA has learned nothing or the server cannot say', async () => {
    getJson.mockResolvedValue(growth([]))
    const empty = render()
    await flushPromises()
    expect(empty.find('[data-widget="fla-growth"]').exists()).toBe(false)
    getJson.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    const old = render()
    await flushPromises()
    expect(old.find('[data-widget="fla-growth"]').exists()).toBe(false)
  })
})
