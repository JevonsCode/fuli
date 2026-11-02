import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import { setMotionPreference } from '@/lib/motion-preference'
import AgentPortraitActions from './AgentPortraitActions.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), deleteJson: vi.fn() }))

const agent = {
  agentId: 'agent-a', personalSpaceId: 'space-a', assignments: [],
  profile: { name: 'Ava', displayName: 'Ava', capabilities: [], status: 'active' },
} as unknown as ProjectAgentRecord

function noWork(url: string) {
  if (url.startsWith('/api/project-agent-tasks?')) return { tasks: [] }
  if (url.startsWith('/api/agent-workflows?')) return { workflows: [] }
  throw new Error(`Unexpected request: ${url}`)
}

async function render(props: Record<string, unknown> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/')
  const wrapper = mount(AgentPortraitActions, {
    props: { agent, spaceId: 'space-a', ...props },
    slots: { default: '<span class="portrait"><img alt="" /></span>' },
    global: { plugins: [router] },
    attachTo: document.body,
  })
  return { wrapper, router }
}

describe('AgentPortraitActions', () => {
  beforeEach(() => {
    getJson.mockReset()
    getJson.mockImplementation(noWork)
  })
  afterEach(() => {
    setMotionPreference('system')
  })

  it('shakes the portrait on click and removes the class once it settles', async () => {
    const { wrapper } = await render()
    const portrait = wrapper.get('.portrait')
    await portrait.trigger('click')
    expect(portrait.classes()).toContain('agent-portrait-shake')
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(portrait.classes()).not.toContain('agent-portrait-shake')
    wrapper.unmount()
  })

  it('skips the shake under reduced motion', async () => {
    setMotionPreference('reduced')
    const { wrapper } = await render()
    await wrapper.get('.portrait').trigger('click')
    expect(wrapper.get('.portrait').classes()).not.toContain('agent-portrait-shake')
    wrapper.unmount()
  })

  it('offers home, workbench and workflow on right-click, never unpin', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) {
        return { tasks: [{ taskId: 't-1', personalSpaceId: 'space-a', status: 'running', ownerAgentId: 'agent-a', participants: [] }] }
      }
      if (url.startsWith('/api/agent-workflows?')) {
        return { workflows: [{ workflowId: 'wf-active', status: 'active', pending: null, updatedAt: '2026-10-30T00:00:00Z' }] }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const { wrapper } = await render()
    await wrapper.get('.portrait').trigger('contextmenu', { clientX: 40, clientY: 60 })
    await flushPromises()

    const menu = document.querySelector('[data-portrait-menu]')
    expect(menu).not.toBeNull()
    const actions = () => [...document.querySelectorAll('[data-portrait-action]')].map(item => item.getAttribute('data-portrait-action'))
    expect(actions()).toContain('home')
    expect(actions()).toContain('workbench')
    expect(actions()).toContain('workflow')
    expect(actions()).not.toContain('unpin')
    // The FLA's name heads the menu.
    expect(menu!.textContent).toContain('Ava')
    wrapper.unmount()
  })
})
