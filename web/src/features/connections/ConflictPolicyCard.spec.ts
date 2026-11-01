import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson }))

import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import ConflictPolicyCard from './ConflictPolicyCard.vue'

const ROUTE = '/api/external-knowledge/conflict-policy'

describe('ConflictPolicyCard', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
    patchJson.mockReset()
  })

  it('shows the default and only the projects set differently', async () => {
    getJson.mockResolvedValue(overview('ask_human', [
      { personalProjectId: 'project-b', mode: 'agent_decide' },
      { personalProjectId: 'project-gone', mode: 'agent_decide' },
    ]))
    const wrapper = mountCard()
    await flushPromises()

    expect(getJson.mock.calls[0][0]).toBe(ROUTE)
    expect(pressed(wrapper, '[data-testid="conflict-policy-default"]')).toBe('ask_human')
    expect(wrapper.findAll('[data-project-id]').map((row) => row.attributes('data-project-id'))).toEqual(['project-b'])
    expect(pressed(wrapper, '[data-project-id="project-b"]')).toBe('agent_decide')
    expect(wrapper.get('[data-project-id="project-b"]').text()).toContain('Project B')
    expect(wrapper.get('[data-testid="conflict-policy-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.zh-CN.md#external-knowledge-conflict-policy',
    )
    setLocale('en-US', { persist: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="conflict-policy-help"]').attributes('href')).toBe(
      'https://github.com/JevonsCode/fuli/blob/main/README.md#external-knowledge-conflict-policy',
    )
    wrapper.unmount()
  })

  it('saves the default, changes an exception and returns it to the default', async () => {
    getJson.mockResolvedValue(overview('ask_human', [{ personalProjectId: 'project-b', mode: 'agent_decide' }]))
    const wrapper = mountCard()
    await flushPromises()

    patchJson.mockResolvedValueOnce({ mode: 'agent_decide', updatedAt: '2026-11-01T00:00:00.000Z' })
    await wrapper.get('[data-testid="conflict-policy-default"] button[data-value="agent_decide"]').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith(`${ROUTE}/default`, { mode: 'agent_decide' }, expect.anything())
    expect(pressed(wrapper, '[data-testid="conflict-policy-default"]')).toBe('agent_decide')

    patchJson.mockResolvedValueOnce({ personalProjectId: 'project-b', mode: 'ask_human', source: 'project' })
    await wrapper.get('[data-project-id="project-b"] button[data-value="ask_human"]').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith(ROUTE,
      { personalSpaceId: 'personal-1', personalProjectId: 'project-b', mode: 'ask_human' }, expect.anything())
    expect(pressed(wrapper, '[data-project-id="project-b"]')).toBe('ask_human')

    patchJson.mockResolvedValueOnce({ personalProjectId: 'project-b', mode: 'agent_decide', source: 'default' })
    await wrapper.get('[data-project-id="project-b"] button[aria-label="“Project B”恢复默认"]').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith(ROUTE,
      { personalSpaceId: 'personal-1', personalProjectId: 'project-b', mode: null }, expect.anything())
    expect(wrapper.find('[data-project-id]').exists()).toBe(false)
    expect(patchJson).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('adds an exception for a project that follows the default, preset to the other choice', async () => {
    getJson.mockResolvedValue(overview('ask_human', [{ personalProjectId: 'project-b', mode: 'agent_decide' }]))
    const wrapper = mountCard()
    await flushPromises()
    const add = wrapper.get('.conflict-policy-add-action')
    await add.trigger('click')

    const picker = wrapper.get('[control-id="conflict-exception-project"]')
    expect(picker.findAll('option').map((option) => option.attributes('value'))).toEqual(['', 'project-a', 'project-c'])
    expect(pressed(wrapper, '.conflict-policy-add')).toBe('agent_decide')
    expect(add.attributes('disabled')).toBeDefined()
    await picker.setValue('project-c')
    let finish!: (value: unknown) => void
    patchJson.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await wrapper.get('.conflict-policy-add').trigger('submit')
    expect(wrapper.get('.growth-loading--inline').text()).toBe('正在保存“Project C”的冲突策略…')
    finish({ personalProjectId: 'project-c', mode: 'agent_decide', source: 'project' })
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith(ROUTE,
      { personalSpaceId: 'personal-1', personalProjectId: 'project-c', mode: 'agent_decide' }, expect.anything())
    expect(wrapper.findAll('[data-project-id]').map((row) => row.attributes('data-project-id'))).toEqual(['project-b', 'project-c'])
    expect(wrapper.find('.conflict-policy-add').exists()).toBe(false)
    expect(wrapper.find('.growth-loading--inline').exists()).toBe(false)
    wrapper.unmount()
  })

  it('offers a retry after a failed read and puts the saved choice back after a failed write', async () => {
    getJson.mockRejectedValueOnce(new Error('Synthetic read failure'))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('读取失败')
    expect(wrapper.get('.conflict-policy-add-action').attributes('disabled')).toBeDefined()

    getJson.mockResolvedValueOnce(overview('ask_human', []))
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    patchJson.mockRejectedValueOnce(new Error('Synthetic save failure'))
    await wrapper.get('[data-testid="conflict-policy-default"] button[data-value="agent_decide"]').trigger('click')
    await flushPromises()
    expect(pressed(wrapper, '[data-testid="conflict-policy-default"]')).toBe('ask_human')
    expect(useConsoleStore().feedback).not.toBeNull()
    wrapper.unmount()
  })

  it('aborts a pending read on unmount', async () => {
    getJson.mockReturnValue(new Promise(() => {}))
    const wrapper = mountCard()
    await flushPromises()
    expect(wrapper.find('.growth-loading--compact').exists()).toBe(true)
    const signal = getJson.mock.calls[0][2].signal as AbortSignal
    wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })
})

function overview(mode: string, projects: Array<{ personalProjectId: string; mode: string }>) {
  return { default: { mode, updatedAt: null }, projects }
}

function pressed(wrapper: VueWrapper, scope: string) {
  return wrapper.get(scope).get('button[aria-pressed="true"]').attributes('data-value')
}

function mountCard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = {
    mode: 'personal_only', activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: 'Synthetic personal space' }],
    personalProjects: ['a', 'b', 'c'].map((suffix) => ({
      project_id: `project-${suffix}`, personal_space_id: 'personal-1',
      profile: { name: `Project ${suffix.toUpperCase()}` },
    })),
    projects: [], subscriptions: [],
  }
  return mount(ConflictPolicyCard, { global: { plugins: [pinia], stubs: { ...optionSelectStubs } } })
}
