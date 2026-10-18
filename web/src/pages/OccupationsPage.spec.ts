import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn(), putJson: vi.fn(), deleteJson: vi.fn(), patchJson: vi.fn() }))
vi.mock('@/api/client', () => api)

import OccupationChip from '@/features/occupations/OccupationChip.vue'
import AgentOccupationEditor from '@/features/agent-profile/AgentOccupationEditor.vue'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentRecord } from '@/types'
import OccupationsPage from './OccupationsPage.vue'

const entry = (key: string, extra: Record<string, unknown> = {}) => ({
  key, name_zh: `职业${key}`, name_en: `Occupation ${key}`, description_zh: `${key} 要做的事情说明`, description_en: `${key} duties text`,
  builtin: true, status: 'active', revision: 1, agent_count: 0, created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', ...extra,
})
let catalog: ReturnType<typeof entry>[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  // A fresh space per test, so the shared catalog cache reads again.
  const spaceId = `space-${Math.random()}`
  store.state = { mode: 'personal_only', activePersonalSpaceId: spaceId, personalSpaces: [{ id: spaceId, name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  catalog = [entry('lead', { agent_count: 3 }), entry('custom_a', { builtin: false, agent_count: 1 }), entry('custom_b', { builtin: false })]
  for (const fn of Object.values(api)) fn.mockReset()
  api.getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/occupations?')) return catalog
    throw new Error(`Unexpected request ${url}`)
  })
})

const mountPage = async () => {
  const wrapper = mount(OccupationsPage, { attachTo: document.body, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

describe('OccupationsPage', () => {
  it('lists the catalog with counts and only lets an unused custom occupation be deleted', async () => {
    const wrapper = await mountPage()
    expect(wrapper.findAll('[data-occupation-row]')).toHaveLength(3)
    expect(wrapper.get('[data-stat="custom"]').text()).toBe('自定义2')
    const row = (key: string) => wrapper.get(`[data-occupation-row="${key}"]`)
    expect(row('lead').find('[data-occupation-remove]').exists()).toBe(false)
    expect(row('custom_a').get('[data-occupation-remove]').attributes('disabled')).toBeDefined()
    expect(row('custom_b').get('[data-occupation-remove]').attributes('disabled')).toBeUndefined()

    api.postJson.mockResolvedValue(entry('lead', { status: 'archived', revision: 2 }))
    await row('lead').get('[data-occupation-archive]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/occupations/lead/archive', expect.objectContaining({ revision: 1 }))
    expect(row('lead').find('[data-occupation-restore]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('creates an occupation only when its duties are written', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-occupation-new]').trigger('click')
    await wrapper.get('input[data-occupation-name]').setValue('数据库')
    await wrapper.get('textarea[data-occupation-duties]').setValue('太短')
    await wrapper.get('form.ui-dialog__shell').trigger('submit')
    expect(api.postJson).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('要做的事至少写 8 个字')

    api.postJson.mockResolvedValue(entry('custom_c', { builtin: false, name_zh: '数据库' }))
    await wrapper.get('textarea[data-occupation-duties]').setValue('设计和维护数据库结构，保证迁移可以回退')
    await wrapper.get('form.ui-dialog__shell').trigger('submit')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/occupations', expect.objectContaining({
      name_zh: '数据库', description_zh: '设计和维护数据库结构，保证迁移可以回退' }))
    expect(wrapper.find('[data-occupation-row="custom_c"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('occupation chips and the editor', () => {
  it('a chip opens the duties of its occupation', async () => {
    await mountPage()
    const chip = mount(OccupationChip, { props: { occupationKey: 'lead' }, attachTo: document.body, global: { stubs: { RouterLink: RouterLinkStub } } })
    await chip.get('[data-occupation="lead"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-occupation-detail]')?.textContent).toContain('lead 要做的事情说明')
    chip.unmount()
  })

  it('shows a locked built-in role read-only', () => {
    const agent = { agentId: 'employee.bole', personalSpaceId: 'space-a', occupationLocked: true,
      occupation: { role: 'management', tags: [], updatedAt: '2026-10-18T00:00:00Z' }, profile: {} } as unknown as ProjectAgentRecord
    const wrapper = mount(AgentOccupationEditor, { props: { agent } })
    expect(wrapper.find('[data-occupation-editor]').exists()).toBe(false)
    expect(wrapper.get('[data-occupation-locked]').text()).toContain('不能修改')
  })
})
