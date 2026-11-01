import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controller = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fit: vi.fn(),
  reset: vi.fn(),
  clearSelection: vi.fn(),
  focusByNames: vi.fn(),
  selectItem: vi.fn(),
  showProjectLeads: vi.fn(),
  destroy: vi.fn(),
}))
const loadProjectLeads = vi.hoisted(() => vi.fn(async () => new Map([['fuli', 'agent-lead']])))
const renderKnowledgeGraph = vi.hoisted(() => vi.fn(() => controller))

vi.mock('./graph-runtime', () => ({
  renderKnowledgeGraph,
  isProjectNode: (node: { type?: string }) => node?.type === 'PersonalProject',
}))
vi.mock('@/features/projects/project-leads', () => ({ loadProjectLeads }))
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({ activePersonalSpace: { id: 'space-a' } }) }))

import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { setLocale } from '@/i18n'
import GraphCanvas from './GraphCanvas.vue'

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GraphCanvas', () => {
  it('shows each project node\'s lead portrait once the leads are read', async () => {
    const wrapper = mount(GraphCanvas, { props: { graph: { nodes: [
      { id: 'personal-project:node-1', name: 'fuli', type: 'PersonalProject', attributes: { projectId: 'fuli' } },
      { id: 'entity-1', name: 'note', type: 'Entity' },
    ], edges: [] } } })
    await vi.waitFor(() => expect(controller.showProjectLeads).toHaveBeenCalled())
    expect(loadProjectLeads).toHaveBeenCalledWith('space-a', ['fuli'])
    const avatarFor = (controller.showProjectLeads.mock.calls[0] as unknown[])[0] as (node: object) => string | null
    expect(avatarFor({ type: 'PersonalProject', attributes: { projectId: 'fuli' } })).toBe(agentAvatarUrl('agent-lead'))
    expect(avatarFor({ type: 'PersonalProject', attributes: { projectId: 'other' } })).toBeNull()
    wrapper.unmount()
  })

  it('passes the project visibility policy through to the renderer', async () => {
    const wrapper = mount(GraphCanvas, { props: {
      graph: { nodes: [], edges: [] }, projectVisibility: 'provided',
    } })
    await vi.waitFor(() => expect(renderKnowledgeGraph).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ projectVisibility: 'provided' }),
    ))
    await wrapper.setProps({ projectVisibility: 'formal' })
    await vi.waitFor(() => expect(renderKnowledgeGraph).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.objectContaining({ projectVisibility: 'formal' }),
    ))
    wrapper.unmount()
  })

  it('restores the URL-selected graph item after rendering', async () => {
    const wrapper = mount(GraphCanvas, {
      props: {
        graph: {
          nodes: [{ id: 'purpose-1', name: '项目目标', type: 'ProjectPurpose' }],
          edges: [],
        },
        selectedItem: {
          itemKind: 'entity',
          id: 'purpose-1',
        },
      },
    })

    await vi.waitFor(() => {
      expect(controller.selectItem).toHaveBeenCalledWith('entity', 'purpose-1')
    })
    wrapper.unmount()
  })

  it('rerenders the command-driven graph when the interface locale changes', async () => {
    const wrapper = mount(GraphCanvas, {
      props: {
        graph: {
          nodes: [{ id: 'project-1', name: '项目', type: 'PersonalProject' }],
          edges: [],
        },
      },
    })
    await vi.waitFor(() => {
      expect(renderKnowledgeGraph).toHaveBeenCalledTimes(1)
    })

    setLocale('en-US', { persist: false })

    await vi.waitFor(() => {
      expect(renderKnowledgeGraph).toHaveBeenCalledTimes(2)
    })
    wrapper.unmount()
  })
})
