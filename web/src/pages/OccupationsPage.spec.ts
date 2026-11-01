import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
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
let spaceId = ''
let router: ReturnType<typeof createRouter>

beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  // A fresh space per test, so the shared catalog cache reads again.
  spaceId = `space-${Math.random()}`
  store.state = { mode: 'personal_only', activePersonalSpaceId: spaceId, personalSpaces: [{ id: spaceId, name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  catalog = [entry('lead', { agent_count: 3 }), entry('custom_a', { builtin: false, agent_count: 1 }), entry('custom_b', { builtin: false })]
  for (const fn of Object.values(api)) fn.mockReset()
  api.getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/occupations?')) return catalog
    throw new Error(`Unexpected request ${url}`)
  })
})

const mountPage = async (path = '/project-agents/occupations') => {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  const wrapper = mount(OccupationsPage, { attachTo: document.body, global: { plugins: [router], stubs: { RouterLink: RouterLinkStub } } })
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

    expect(row('lead').get('[data-occupation-kind]').text()).toBe('内置')
    expect(row('custom_a').get('[data-occupation-kind]').text()).toBe('自定义')
    expect(row('lead').get('[data-occupation-agents]').text()).toBe('3')
    wrapper.unmount()
  })

  it('shows only active occupations until the archived filter is chosen, and archive can be undone', async () => {
    catalog.push(entry('old_role', { status: 'archived', revision: 4 }))
    const wrapper = await mountPage()
    const keys = () => wrapper.findAll('[data-occupation-row]').map(row => row.attributes('data-occupation-row'))
    expect(keys()).not.toContain('old_role')
    expect(wrapper.get('[data-stat="active"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-stat="active"]').attributes('data-term')).toBe('occupation.active')
    expect(wrapper.get('[data-occupation-row="lead"] [data-occupation-archive]').attributes('title')).toContain('随时可以恢复')

    api.postJson.mockResolvedValue(entry('lead', { status: 'archived', revision: 2, agent_count: 3 }))
    await wrapper.get('[data-occupation-row="lead"] [data-occupation-archive]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/occupations/lead/archive', expect.objectContaining({ revision: 1 }), expect.objectContaining({ schema: expect.anything() }))
    expect(keys()).not.toContain('lead')
    expect(wrapper.get('[data-occupation-archived-notice]').text()).toContain('已有它的 Agent 保留')

    api.putJson.mockResolvedValue(entry('lead', { revision: 3, agent_count: 3 }))
    await wrapper.get('[data-occupation-undo-archive]').trigger('click')
    await flushPromises()
    expect(api.putJson).toHaveBeenCalledWith('/api/occupations/lead', expect.objectContaining({ revision: 2, status: 'active' }), expect.objectContaining({ schema: expect.anything() }))
    expect(keys()).toContain('lead')

    await wrapper.get('[data-stat="archived"]').trigger('click')
    expect(keys()).toEqual(['old_role'])
    api.putJson.mockResolvedValue(entry('old_role', { revision: 5 }))
    await wrapper.get('[data-occupation-row="old_role"] [data-occupation-restore]').trigger('click')
    await flushPromises()
    expect(api.putJson).toHaveBeenLastCalledWith('/api/occupations/old_role', expect.objectContaining({ revision: 4, status: 'active' }), expect.objectContaining({ schema: expect.anything() }))
    expect(keys()).toEqual([])
    wrapper.unmount()
  })

  it('sorts by a column header and marks the sorted column', async () => {
    const wrapper = await mountPage()
    const header = wrapper.get('[data-occupation-column="agents"]')
    expect(header.attributes('data-term')).toBe('occupation.agentCount')
    await header.get('button').trigger('click')
    expect(header.attributes('aria-sort')).toBe('descending')
    expect(wrapper.findAll('[data-occupation-row]').map(row => row.attributes('data-occupation-row'))).toEqual(['lead', 'custom_a', 'custom_b'])
    await header.get('button').trigger('click')
    expect(wrapper.findAll('[data-occupation-row]').map(row => row.attributes('data-occupation-row'))).toEqual(['custom_b', 'custom_a', 'lead'])
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
      name_zh: '数据库', description_zh: '设计和维护数据库结构，保证迁移可以回退' }), expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-occupation-row="custom_c"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('OccupationsPage quick look', () => {
  const inBody = (selector: string) => document.body.querySelector<HTMLElement>(selector)
  const itemFor = (key: string, space = spaceId) => `${encodeURIComponent(space)}/${encodeURIComponent(key)}`

  it('opens a card in a quick look named in the URL, and closing goes back with focus on the opener', async () => {
    const wrapper = await mountPage()
    const opener = wrapper.get('[data-occupation-row="custom_b"] [data-occupation-open]')
    ;(opener.element as HTMLElement).focus()
    await opener.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.item).toBe(itemFor('custom_b'))
    expect(inBody('[data-occupation-peek-duties]')?.textContent).toContain('custom_b 要做的事情说明')
    // The open card lifts as a card; it never gets a side bar.
    expect(wrapper.get('[data-occupation-row="custom_b"]').classes()).toContain('is-selected')

    ;(inBody('[data-occupation-peek]')!.closest('[role="dialog"]') ?? inBody('[data-occupation-peek]'))!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 20))
    await flushPromises()
    expect(router.currentRoute.value.query.item).toBeUndefined()
    expect(inBody('[data-occupation-peek]')).toBeNull()
    expect(document.activeElement).toBe(opener.element)
    wrapper.unmount()
  })

  it('reopens a shared link by its exact key and closes it with the browser Back', async () => {
    const wrapper = await mountPage()
    await router.push(`/project-agents/occupations?item=${itemFor('lead')}`)
    await flushPromises()
    expect(inBody('[data-occupation-peek]')?.textContent).toContain('职业lead')
    expect(inBody('[data-peek-remove]')).toBeNull()
    router.back()
    await flushPromises()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(router.currentRoute.value.query.item).toBeUndefined()
    expect(inBody('[data-occupation-peek]')).toBeNull()
    wrapper.unmount()
  })

  it('keeps a shared link open with a retry when the catalog cannot be read, never calling it missing', async () => {
    let fail = true
    api.getJson.mockImplementation(async (url: string) => {
      if (!url.startsWith('/api/occupations?')) throw new Error(`Unexpected request ${url}`)
      if (fail) throw new Error('HTTP 503')
      return catalog
    })
    const wrapper = await mountPage(`/project-agents/occupations?item=${itemFor('custom_b')}`)
    const peek = inBody('[data-occupation-peek]')!
    expect(peek.querySelector('[data-occupation-peek-error]')?.textContent).toContain('HTTP 503')
    expect(peek.textContent).not.toContain('当前空间里没有这个职业')
    expect(wrapper.find('[data-occupations-load-error]').exists()).toBe(true)
    fail = false
    ;(peek.querySelector('[data-peek-retry]') as HTMLButtonElement).click()
    await flushPromises()
    expect(inBody('[data-occupation-peek-duties]')?.textContent).toContain('custom_b 要做的事情说明')
    expect(router.currentRoute.value.query.item).toBe(itemFor('custom_b'))
    wrapper.unmount()
  })

  it('says an occupation is missing only after the whole catalog of this space was read', async () => {
    const wrapper = await mountPage(`/project-agents/occupations?item=${itemFor('gone')}`)
    expect(inBody('[data-occupation-peek]')?.textContent).toContain('当前空间里没有这个职业')
    wrapper.unmount()
    const other = await mountPage(`/project-agents/occupations?item=${itemFor('lead', 'another-space')}`)
    expect(inBody('[data-occupation-peek]')?.textContent).toContain('当前空间里没有这个职业')
    other.unmount()
  })

  it('hands over to the edit dialog and closes after deleting the occupation it shows', async () => {
    const wrapper = await mountPage(`/project-agents/occupations?item=${itemFor('custom_b')}`)
    inBody('[data-peek-edit]')!.click()
    await flushPromises()
    expect(inBody('[data-occupation-peek]')).toBeNull()
    expect((inBody('input[data-occupation-name]') as HTMLInputElement).value).toBe('职业custom_b')
    wrapper.unmount()

    const again = await mountPage(`/project-agents/occupations?item=${itemFor('custom_b')}`)
    api.deleteJson.mockResolvedValue({})
    inBody('[data-peek-remove]')!.click()
    await flushPromises()
    expect(api.deleteJson).toHaveBeenCalledWith('/api/occupations/custom_b', expect.objectContaining({ revision: 1 }))
    expect(router.currentRoute.value.query.item).toBeUndefined()
    expect(again.find('[data-occupation-row="custom_b"]').exists()).toBe(false)
    again.unmount()
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
