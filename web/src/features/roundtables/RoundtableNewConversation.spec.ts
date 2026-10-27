import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.fn()
const postJson = vi.fn()
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({ state: { personalProjects: [
  { project_id: 'alpha', personal_space_id: 's', profile: { name: 'Alpha app' } },
  { project_id: 'beta', personal_space_id: 's', profile: { name: 'Beta site' } },
] } }) }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(),
  getJson: (url: string) => getJson(url), postJson: (url: string, body: unknown) => postJson(url, body) }))

import { setLocale } from '@/i18n'
import RoundtableNewConversation from './RoundtableNewConversation.vue'

async function mountNew() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { template: '<div />' } }] })
  await router.push('/roundtables')
  const wrapper = mount(RoundtableNewConversation, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('RoundtableNewConversation', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    postJson.mockReset()
    getJson.mockReset().mockResolvedValue({ agents: [
      { agentId: 'ada', name: 'Ada Vale', responsibility: 'Release', projects: ['alpha'] },
      { agentId: 'bo', name: 'Bo Lin', responsibility: null, projects: ['alpha', 'beta'] },
      { agentId: 'cy', name: 'Cy Moss', responsibility: null, projects: ['beta'] },
    ] })
  })

  it('starts an instant group conversation in the project the chosen FLAs share and opens it', async () => {
    postJson.mockResolvedValue({ id: 'thread-9' })
    const { wrapper, router } = await mountNew()
    expect(getJson).toHaveBeenCalledWith('/api/roundtable/agents')
    for (const id of ['ada', 'bo']) await wrapper.get(`[data-roundtable-agent="${id}"] button`).trigger('click')
    expect(wrapper.find('[data-roundtable-project]').exists()).toBe(false)
    await wrapper.get('textarea').setValue('Can we ship Friday?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/roundtable/threads', { to: ['ada', 'bo'], body: 'Can we ship Friday?', mode: 'instant', projectId: 'alpha' })
    expect(router.currentRoute.value.fullPath).toBe('/roundtables/thread-9')
  })

  it('asks for a project when the FLA works in several, and says when the chosen ones share none', async () => {
    const { wrapper } = await mountNew()
    await wrapper.get('[data-roundtable-agent="bo"] button').trigger('click')
    expect(wrapper.find('[data-roundtable-project]').exists()).toBe(true)
    expect(wrapper.get('[data-roundtable-send]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-roundtable-agent="bo"] button').trigger('click')
    await wrapper.get('[data-roundtable-agent="ada"] button').trigger('click')
    await wrapper.get('[data-roundtable-agent="cy"] button').trigger('click')
    expect(wrapper.text()).toContain('选中的 FLA 不在同一个项目里')
  })
})
