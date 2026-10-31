import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import TeamCard from './TeamCard.vue'
import TeamIsland from './TeamIsland.vue'
import type { TeamSheet } from './team-sheets'
import { forgetTeamWork } from './useTeamWork'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn() }))

// Synthetic team work only.
const sheet = (overrides: Partial<TeamSheet> = {}): TeamSheet => ({
  taskId: 'task-1', personalProjectId: null, title: 'Synthetic export upgrade', objective: null, status: 'running', leadAgentId: 'lead',
  updatedAt: null, blocker: null, progress: { completed: 2, total: 5 }, unassignedSteps: 0,
  steps: [
    { id: 's1', title: 'Map fields', status: 'completed', agentId: 'a' },
    { id: 's2', title: 'Write script', status: 'in_progress', agentId: 'a' },
    { id: 's3', title: 'Review', status: 'pending', agentId: 'lead' },
  ],
  shares: [
    { agentId: 'lead', role: 'lead', status: 'running', assignment: 'Review the result', progress: { completed: 0, total: 1 } },
    { agentId: 'a', role: 'collaborator', status: 'running', assignment: 'Migrate the data', progress: { completed: 1, total: 2 } },
    { agentId: 'b', role: 'collaborator', status: 'queued', assignment: null, progress: null },
  ],
  ...overrides,
})
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
const names: Record<string, string> = { lead: 'Lumen', a: 'Aster', b: 'Birch' }
const mounted: Array<{ unmount: () => void }> = []

beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic' }], personalProjects: [], projects: [], subscriptions: [] } as never
  getJson.mockReset()
  forgetTeamWork()
})
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); forgetTeamWork() })

describe('团队卡片', () => {
  it('rings each portrait only from recorded progress and lets the current step breathe', () => {
    const wrapper = mount(TeamCard, { props: { sheet: sheet(), spaceId: 'space-a', nameOf: (id: string) => names[id]!, projectName: (id: string) => id }, global: { plugins: [router()] } })
    mounted.push(wrapper)
    const faces = wrapper.findAll('.team-face')
    expect(faces).toHaveLength(3)
    expect(faces[0]!.classes()).toContain('is-lead')
    expect(faces.map(face => face.find('.team-ring').exists())).toEqual([true, true, false])
    expect(faces[1]!.classes()).toContain('is-working')
    expect(wrapper.text()).toContain('Aster 正在Write script')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('2')
  })

  it('opens into each share’s to-do list, with the viewer’s own share first', async () => {
    const wrapper = mount(TeamCard, { props: { sheet: sheet(), spaceId: 'space-a', nameOf: (id: string) => names[id]!, projectName: (id: string) => id, viewerAgentId: 'b' }, global: { plugins: [router()] } })
    mounted.push(wrapper)
    expect(wrapper.get('.team-head').attributes('aria-expanded')).toBe('false')
    await wrapper.get('.team-head').trigger('click')
    expect(wrapper.get('.team-head').attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('[data-team-share]').map(item => item.attributes('data-team-share'))).toEqual(['b', 'lead', 'a'])
    const aster = wrapper.get('[data-team-share="a"]')
    expect(aster.findAll('.team-step').map(step => step.attributes('data-step-status'))).toEqual(['completed', 'in_progress'])
    // No recorded steps: status only, never a bar.
    expect(wrapper.get('[data-team-share="b"]').find('[role="progressbar"]').exists()).toBe(false)
  })
})

describe('悬浮岛', () => {
  const mountIsland = async () => {
    const wrapper = mount(TeamIsland, { attachTo: document.body, global: { plugins: [router()] } })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
  }

  it('says who is working on what together, and opens into the team card', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workbenches?')) return { partial: false, workbenches: [sheet(), sheet({ taskId: 'task-2', title: 'Second synthetic task' })] }
      if (url.startsWith('/api/project-agents/')) return { agentId: url.split('/')[3]!.split('?')[0], profile: { name: names[url.split('/')[3]!.split('?')[0]!] ?? 'X' } }
      throw new Error(`Unexpected request: ${url}`)
    })
    const island = await mountIsland()
    const pill = island.get('[data-team-island-pill]')
    expect(pill.text()).toContain('3 位 FLA 正在一起做「Synthetic export upgrade」')
    expect(pill.text()).toContain('2/5')
    expect(pill.text()).toContain('还有 1 个')
    await pill.trigger('click')
    expect(pill.attributes('aria-expanded')).toBe('true')
    expect(island.find('[data-team-card="task-1"]').exists()).toBe(true)
    await island.get('[aria-label="下一个任务"]').trigger('click')
    expect(island.find('[data-team-card="task-2"]').exists()).toBe(true)
  })

  it('is not there when nothing runs together, nor when the server cannot say', async () => {
    getJson.mockResolvedValue({ partial: false, workbenches: [sheet({ status: 'queued' })] })
    expect((await mountIsland()).find('[data-team-island-pill]').exists()).toBe(false)
    forgetTeamWork()
    getJson.mockRejectedValue(new ApiError('Not found', 404))
    expect((await mountIsland()).find('[data-team-island-pill]').exists()).toBe(false)
  })
})
