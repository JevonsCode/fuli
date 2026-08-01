import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MINIMUM_LOADING_DISPLAY_MS } from '@/composables/useMinimumLoadingDisplay'

const getJson = vi.hoisted(() => vi.fn())
const graphCalls = vi.hoisted(() => ({
  clearSelection: vi.fn(),
  selectItem: vi.fn(() => true),
}))

vi.mock('@/api/client', () => ({ getJson, patchJson: vi.fn() }))
vi.mock('./GraphCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'GraphCanvasStub',
      props: ['graph', 'selectedItem'],
      setup(_props, { expose }) {
        expose({
          clearSelection: graphCalls.clearSelection,
          selectItem: graphCalls.selectItem,
          focusByNames: () => 0,
        })
        return () => h('div', { class: 'graph-canvas-stub' })
      },
    }),
  }
})

import { useConsoleStore } from '@/stores/console'
import KnowledgeWorkspace from './KnowledgeWorkspace.vue'

const purposeId = 'project-profile:project-1:purpose'
const graph = {
  nodes: [
    {
      id: 'personal-project:space-1:project-1',
      name: '项目一',
      type: 'PersonalProject',
      attributes: { projectId: 'project-1' },
    },
    {
      id: purposeId,
      name: '项目目标',
      type: 'ProjectPurpose',
      summary: '项目存在的原因。',
    },
    {
      id: 'knowledge-1',
      name: '知识一',
      type: 'Decision',
      summary: '一条可以确认的知识。',
      origin_quadrant: 'known_known',
      epistemic_state_explicit: true,
      confirmation_status: 'pending',
      confirmation_state_explicit: false,
    },
  ],
  edges: [{
    id: 'project-profile-edge:project-1:purpose',
    source: 'personal-project:space-1:project-1',
    target: purposeId,
    type: 'HAS_PURPOSE',
    fact: '项目具备明确目标。',
  }],
}

describe('KnowledgeWorkspace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    getJson.mockReset()
    getJson.mockResolvedValue(graph)
    graphCalls.clearSelection.mockClear()
    graphCalls.selectItem.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores graph highlighting after a deep-linked directory item returns to the graph', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [{
        personal_space_id: 'space-1',
        project_id: 'project-1',
        profile: { name: '项目一' },
      }],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
        name: 'personal-project-item',
        component: { template: '<div />' },
      }],
    })
    await router.push(
      `/personal/space-1/projects/project-1/directory/entity/${encodeURIComponent(purposeId)}`,
    )
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    expect(wrapper.get('#directory-tab-materials').attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('.project-material-row')).toHaveLength(3)

    await wrapper.get('.inspector-actions button.secondary-action').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params.mode).toBe('graph')
    expect(graphCalls.selectItem).toHaveBeenCalledWith('entity', purposeId)
    expect(graphCalls.selectItem.mock.invocationCallOrder.at(-1))
      .toBeGreaterThan(graphCalls.clearSelection.mock.invocationCallOrder.at(-1) ?? 0)
    wrapper.unmount()
  })

  it('shows the direct parent beside the graph instead of as a peer node', async () => {
    getJson.mockResolvedValue({
      nodes: [
        ...graph.nodes,
        {
          id: 'personal-project-related:project-2',
          name: '项目二',
          type: 'RelatedPersonalProject',
          summary: '上级项目档案',
          attributes: { projectId: 'project-2' },
        },
      ],
      edges: [
        ...graph.edges,
        {
          id: 'personal-project-relation:parent',
          source: 'personal-project:space-1:project-1',
          target: 'personal-project-related:project-2',
          type: 'PART_OF',
          fact: '项目一属于项目二。',
        },
      ],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [
        {
          personal_space_id: 'space-1',
          project_id: 'project-1',
          profile: { name: '项目一' },
        },
        {
          personal_space_id: 'space-1',
          project_id: 'project-2',
          profile: { name: '项目二' },
        },
      ],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/personal/:spaceId/projects/:projectId/:mode',
        name: 'personal-project',
        component: { template: '<div />' },
      }],
    })
    await router.push('/personal/space-1/projects/project-1/graph')
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    expect(wrapper.get('.project-hierarchy-aside').text()).toContain('上级项目')
    expect(wrapper.get('.project-parent-link').text()).toContain('项目二')
    expect(wrapper.get('.project-parent-link').text()).toContain('项目一 属于此项目')
    expect(wrapper.get('.project-parent-link').attributes('href'))
      .toBe('/personal/space-1/projects/project-2/graph')

    const renderedGraph = wrapper.findComponent({ name: 'GraphCanvasStub' })
      .props('graph') as typeof graph
    expect(renderedGraph.nodes.map(({ id }) => id))
      .not.toContain('personal-project-related:project-2')
    expect(renderedGraph.edges.map(({ id }) => id))
      .not.toContain('personal-project-relation:parent')
    expect(wrapper.get('.graph-relation-legend').text()).toContain('目标')
    expect(wrapper.text()).not.toContain('PART_OF')
    expect(wrapper.text()).not.toContain('HAS_PURPOSE')
    wrapper.unmount()
  })

  it('confirms personal-profile knowledge without narrowing the mutation to the active project', async () => {
    const preferenceId = 'preference-1'
    getJson.mockResolvedValue({
      nodes: [{
        id: preferenceId,
        name: '使用干净的实心选中态',
        type: 'DesignTaste',
        summary: '避免齿轮状、虚线或点状选中环。',
        origin_quadrant: 'known_known',
        epistemic_state_explicit: true,
        confirmation_status: 'pending',
        confirmation_state_explicit: false,
        profile_aspect: 'taste',
        preference_scope: 'global',
      }],
      edges: [],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [{
        personal_space_id: 'space-1',
        project_id: 'project-1',
        profile: { name: '项目一' },
      }],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
        name: 'personal-project-item',
        component: { template: '<div />' },
      }],
    })
    await router.push(
      `/personal/space-1/projects/project-1/directory/entity/${preferenceId}`,
    )
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: {
            props: ['item', 'personalProjectId'],
            template: `
              <div
                v-if="item"
                data-testid="confirm-dialog-stub"
                :data-project-id="personalProjectId ?? 'none'"
              />
            `,
          },
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    await wrapper.get('.inspector-confirm-action').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="confirm-dialog-stub"]').attributes('data-project-id'))
      .toBe('none')
    wrapper.unmount()
  })

  it('separates knowledge content and project material into clear directory tabs', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [{
        personal_space_id: 'space-1',
        project_id: 'project-1',
        profile: { name: '项目一' },
      }],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/personal/:spaceId/projects/:projectId/:mode',
          name: 'personal-project',
          component: { template: '<div />' },
        },
        {
          path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
          name: 'personal-project-item',
          component: { template: '<div />' },
        },
      ],
    })
    await router.push('/personal/space-1/projects/project-1/directory/entity/knowledge-1')
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    expect(wrapper.get('#directory-tab-knowledge').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('#directory-tab-knowledge').text()).toContain('1')
    expect(wrapper.get('#directory-tab-materials').text()).toContain('3')
    expect(wrapper.findAll('.knowledge-row')).toHaveLength(1)
    expect(wrapper.find('.project-material-row').exists()).toBe(false)
    expect(wrapper.get('.virtual-directory-list__watermark').text()).toBe('#001')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 001')
    expect(getJson.mock.calls.map(([url]) => String(url)).filter((url) => (
      url.startsWith('/api/graph?')
    ))).toEqual([
      '/api/graph?spaceId=space-1&limit=360&personalProjectId=project-1',
    ])

    await wrapper.get('#directory-tab-materials').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.section).toBe('materials')
    expect(wrapper.get('#directory-tab-materials').attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('.project-material-row')).toHaveLength(3)
    expect(wrapper.get('.virtual-directory-list__watermark').text()).toBe('#001')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 003')
    expect(wrapper.find('.knowledge-table-head').exists()).toBe(false)
    expect(wrapper.get('.search-form input').attributes('aria-label')).toBe('搜索项目资料')

    await wrapper.get('#directory-tab-knowledge').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.section).toBeUndefined()
    expect(wrapper.findAll('.knowledge-row')).toHaveLength(1)
    wrapper.unmount()
  })

  it('shows current, historical, and all knowledge as direct status choices', async () => {
    getJson.mockResolvedValue({
      nodes: [
        {
          id: 'knowledge-current',
          name: '当前知识',
          type: 'Decision',
          summary: '仍然有效的内容。',
        },
        {
          id: 'knowledge-historical',
          name: '历史知识',
          type: 'Decision',
          summary: '已被新口径取代的内容。',
          invalid_at: '2026-07-28T08:00:00Z',
        },
      ],
      edges: [],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [{
        personal_space_id: 'space-1',
        project_id: 'project-1',
        profile: { name: '项目一' },
      }],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/personal/:spaceId/projects/:projectId/:mode',
        name: 'personal-project',
        component: { template: '<div />' },
      }],
    })
    await router.push('/personal/space-1/projects/project-1/directory')
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    expect(wrapper.get('#directory-tab-knowledge').text()).toContain('知识内容2')
    expect(wrapper.get('#directory-tab-knowledge').text()).not.toContain('/')
    expect(wrapper.find('[aria-label="内容状态"]').exists()).toBe(false)
    expect(wrapper.get('[data-status="current"]').text()).toContain('当前有效 1')
    expect(wrapper.get('[data-status="historical"]').text()).toContain('已失效 1')
    expect(wrapper.get('[data-status="all"]').text()).toContain('全部 2')
    expect(wrapper.get('[data-status="current"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.knowledge-row')).toHaveLength(1)
    expect(wrapper.get('.knowledge-row').text()).toContain('当前知识')

    await wrapper.get('[data-status="historical"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.status).toBe('historical')
    expect(wrapper.get('[data-status="historical"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.knowledge-row')).toHaveLength(1)
    expect(wrapper.get('.knowledge-row').text()).toContain('历史知识')

    await wrapper.get('[data-status="all"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.status).toBe('all')
    expect(wrapper.get('[data-status="all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.knowledge-row')).toHaveLength(2)

    await wrapper.get('[data-status="current"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.query.status).toBeUndefined()
    expect(wrapper.get('[data-status="current"]').attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('jumps from historical knowledge to its replacement and clears hiding filters', async () => {
    getJson.mockResolvedValue({
      nodes: [
        {
          id: 'knowledge-current',
          name: '当前知识',
          type: 'Decision',
          summary: '替代后的当前内容。',
        },
        {
          id: 'knowledge-historical',
          name: '历史知识',
          type: 'Decision',
          summary: '已被新口径取代的内容。',
          invalid_at: '2026-07-28T08:00:00Z',
          replaced_by_item_id: 'knowledge-current',
          replaced_by_item_kind: 'entity',
        },
      ],
      edges: [],
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [{
        personal_space_id: 'space-1',
        project_id: 'project-1',
        profile: { name: '项目一' },
      }],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/personal/:spaceId/projects/:projectId/:mode',
          name: 'personal-project',
          component: { template: '<div />' },
        },
        {
          path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
          name: 'personal-project-item',
          component: { template: '<div />' },
        },
      ],
    })
    await router.push(
      '/personal/space-1/projects/project-1/directory/entity/knowledge-historical'
      + '?status=historical&q=%E5%8E%86%E5%8F%B2',
    )
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    await wrapper.get('.inspector-replacement-link').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.params.itemId).toBe('knowledge-current')
    expect(router.currentRoute.value.query.status).toBeUndefined()
    expect(router.currentRoute.value.query.q).toBeUndefined()
    expect(wrapper.get('[data-status="current"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.knowledge-row').text()).toContain('当前知识')
    wrapper.unmount()
  })

  it('loads only the active project plus projects explicitly selected as context', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'space-1',
      personalSpaces: [{ id: 'space-1', name: '我' }],
      personalProjects: [
        {
          personal_space_id: 'space-1',
          project_id: 'project-1',
          profile: { name: '项目一' },
        },
        {
          personal_space_id: 'space-1',
          project_id: 'project-2',
          profile: { name: '项目二' },
        },
      ],
      projects: [],
      subscriptions: [],
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/personal/:spaceId/projects/:projectId/:mode',
        name: 'personal-project',
        component: { template: '<div />' },
      }],
    })
    await router.push(
      '/personal/space-1/projects/project-1/directory?context=project-2',
    )
    await router.isReady()

    const wrapper = mount(KnowledgeWorkspace, {
      props: { personalProjectsOnly: true },
      global: {
        plugins: [pinia, router],
        stubs: {
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeProjectDialog: true,
          PersonalProjectProfileDialog: true,
          PublishProjectDialog: true,
        },
      },
    })
    await finishInitialLoading()

    expect(getJson.mock.calls.map(([url]) => String(url)).filter((url) => (
      url.startsWith('/api/graph?')
    ))).toEqual([
      '/api/graph?spaceId=space-1&limit=360&personalProjectId=project-1',
      '/api/graph?spaceId=space-1&limit=360&personalProjectId=project-2',
    ])
    expect(
      wrapper.get('.personal-context-picker summary .searchable-select-arrow')
        .attributes('aria-hidden'),
    ).toBe('true')
    wrapper.unmount()
  })
})

async function finishInitialLoading() {
  await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS)
  vi.useRealTimers()
  await flushPromises()
}
