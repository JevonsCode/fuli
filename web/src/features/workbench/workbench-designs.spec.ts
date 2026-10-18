import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { Component } from 'vue'
import type { AgentAttention } from '@/features/project-agents/attention-store'
import type { ProjectAgentTaskRecord } from '@/types'
import FocusBoard from './FocusBoard.vue'
import KanbanBoard from './KanbanBoard.vue'
import TimelineBoard from './TimelineBoard.vue'
import ConstellationBoard from './ConstellationBoard.vue'
import type { WorkbenchBoard } from './workbench-board'

const recent = new Date(Date.now() - 30 * 60_000).toISOString()
const task = (taskId: string, status: ProjectAgentTaskRecord['status'], extra: Partial<ProjectAgentTaskRecord> = {}) =>
  ({ taskId, title: `Task ${taskId}`, status, participants: [], leadAgentId: 'agent-a', personalProjectId: 'fuli', updatedAt: recent, ...extra }) as ProjectAgentTaskRecord
const board = (tasks: ProjectAgentTaskRecord[], attention: AgentAttention[] = []): WorkbenchBoard => ({
  tasks, attention,
  projectName: id => (id ? `Project ${id}` : '—'),
  agentFace: () => ({ name: 'Ada', image: null, color: null, softColor: null }),
  taskHref: item => `/tasks/${item.taskId}`,
  questionHref: item => `/inbox/${item.requestId}`,
  statusLabel: status => status,
  since: () => 'now',
})
const mountDesign = (component: Component, value: WorkbenchBoard) =>
  mount(component, { props: { board: value } as Record<string, unknown>, global: { stubs: { RouterLink: RouterLinkStub } } })
const question = { requestId: 'q1', personalSpaceId: 's', personalProjectId: 'fuli', agentId: 'agent-a', taskId: null, kind: 'decision',
  title: 'Pick a palette', detail: 'Gold or ink', requestedAction: '', revision: 1, status: 'open', createdAt: recent } as AgentAttention

describe('workbench designs', () => {
  it('Focus leads with the open question and links to answer it', () => {
    const wrapper = mountDesign(FocusBoard, board([task('r', 'running'), task('b', 'blocked', { failureReason: 'Needs a token' })], [question]))
    expect(wrapper.get('[data-focus-hero]').text()).toContain('Pick a palette')
    expect(wrapper.get('[data-focus-action]').findComponent(RouterLinkStub).props('to')).toBe('/inbox/q1')
    expect(wrapper.findAll('[data-focus-working]')).toHaveLength(1)
    expect(wrapper.get('[data-focus-stuck]').text()).toContain('Needs a token')
  })

  it('Focus is calm when nothing needs the person', () => {
    const wrapper = mountDesign(FocusBoard, board([task('r', 'running')]))
    expect(wrapper.get('[data-focus-hero]').classes()).toContain('is-calm')
  })

  it('Board puts questions first in "needs you" and each task in its lane', () => {
    const wrapper = mountDesign(KanbanBoard, board([task('r', 'running'), task('b', 'blocked'), task('v', 'awaiting_review')], [question]))
    const lane = (name: string) => wrapper.get(`[data-lane="${name}"]`)
    expect(lane('waiting').find('[data-kanban-question]').exists()).toBe(true)
    expect(lane('waiting').text()).toContain('Task v')
    expect(lane('running').text()).toContain('Task r')
    expect(lane('stuck').text()).toContain('Task b')
  })

  it('Timeline lists the last hour of work with who did it', () => {
    const wrapper = mountDesign(TimelineBoard, board([task('r', 'running')]))
    expect(wrapper.findAll('[data-timeline-hour]')).toHaveLength(1)
    expect(wrapper.text()).toContain('Ada')
    expect(wrapper.text()).toContain('Task r')
  })

  it('Star map draws a planet per project and a moon per Agent in its state, linking to the work', () => {
    // RouterLink in custom mode hands its href to the SVG anchor.
    const CustomLink = { props: ['to', 'custom'], template: '<slot :href="String(to)" :navigate="() => {}" />' }
    const value = board([task('r', 'running'), task('b', 'blocked', { leadAgentId: 'agent-b' }), task('x', 'running', { personalProjectId: 'docs', leadAgentId: 'agent-c' })], [question])
    const wrapper = mount(ConstellationBoard, { props: { board: value }, global: { stubs: { RouterLink: CustomLink } } })
    expect(wrapper.findAll('[data-planet]')).toHaveLength(2)
    const moons = wrapper.findAll('[data-moon]')
    expect(moons.map(moon => moon.classes().find(name => name.startsWith('is-')))).toEqual(['is-waiting', 'is-stuck', 'is-running'])
    expect(moons[0]!.attributes('href')).toBe('/inbox/q1')
    expect(moons[1]!.attributes('href')).toBe('/tasks/b')
    expect(wrapper.text()).toContain('Project fuli')
  })

  it('Star map says the Agents are resting when nothing is in progress', () => {
    const wrapper = mountDesign(ConstellationBoard, board([]))
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toContain('休息')
  })
})

describe('3D workbench designs', () => {
  it('fall back to the 2D star map where WebGL is unavailable', async () => {
    const { default: Workbench3D } = await import('./Workbench3D.vue')
    const CustomLink = { props: ['to', 'custom'], template: '<slot :href="String(to)" :navigate="() => {}" />' }
    const wrapper = mount(Workbench3D, {
      props: { board: board([task('r', 'running')]), scene: 'office' },
      global: { plugins: [createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })], stubs: { RouterLink: CustomLink } },
    })
    // three.js loads on demand; jsdom has no WebGL, so the 2D map stands in.
    await vi.waitFor(async () => { await flushPromises(); expect(wrapper.find('[data-workbench="constellation"]').exists()).toBe(true) }, { timeout: 4000 })
    wrapper.unmount()
  })
})
