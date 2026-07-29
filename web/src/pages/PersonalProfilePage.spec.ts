import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  getJson,
  postJson,
  patchJson,
}))

import SearchableSelect from '@/components/SearchableSelect.vue'
import { useConsoleStore } from '@/stores/console'
import PersonalProfilePage from './PersonalProfilePage.vue'

describe('PersonalProfilePage', () => {
  beforeEach(() => {
    getJson.mockReset()
    getJson.mockResolvedValue(profileGraph())
    postJson.mockReset()
    postJson.mockResolvedValue({})
    patchJson.mockReset()
    patchJson.mockResolvedValue({})
  })

  it('filters collaboration preferences by global or one exact personal project', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [
        { project_id: 'project-a', personal_space_id: 'personal-space', profile: { name: '项目 A' } },
        { project_id: 'project-b', personal_space_id: 'personal-space', profile: { name: '项目 B' } },
      ],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(PersonalProfilePage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.findAll('.personal-profile-row')).toHaveLength(3)
    const scope = wrapper.getComponent(SearchableSelect)
    expect(scope.props('options')).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'all', label: '全部范围' }),
      expect.objectContaining({ value: 'global', label: '个人全局' }),
      expect.objectContaining({ value: 'project:project-a', label: '项目 A' }),
      expect.objectContaining({ value: 'project:project-b', label: '项目 B' }),
    ]))
    const chooseScope = async (label: string) => {
      await scope.get('[role="combobox"]').trigger('click')
      const option = scope
        .findAll('.searchable-select-option')
        .find((candidate) => candidate.text().includes(label))
      expect(option).toBeDefined()
      await option!.trigger('click')
    }

    await chooseScope('项目 A')
    expect(wrapper.findAll('.personal-profile-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('A 项目判断')
    expect(wrapper.text()).not.toContain('B 项目个性')
    expect(wrapper.text()).not.toContain('全局品味')

    await chooseScope('个人全局')
    expect(wrapper.findAll('.personal-profile-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('全局品味')
    expect(wrapper.text()).not.toContain('A 项目判断')
  })

  it('treats a project preference as an override instead of a global conflict', async () => {
    const graph = profileGraph()
    graph.nodes[0].attributes = { preferenceKey: 'layout.density' }
    graph.nodes[1].attributes = { preferenceKey: 'layout.density' }
    getJson.mockResolvedValue(graph)

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [
        { project_id: 'project-a', personal_space_id: 'personal-space', profile: { name: '项目 A' } },
      ],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(PersonalProfilePage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })
    await flushPromises()

    const conflictAction = wrapper
      .findAll('.personal-profile-summary > button')
      .find((button) => button.attributes('aria-label') === '当前没有疑似冲突')
    expect(conflictAction?.text()).toContain('0')
  })

  it('makes status totals actionable and opens confirmation for a pending preference', async () => {
    const graph = profileGraph()
    Object.assign(graph.nodes[0], {
      confirmation_status: 'pending',
      epistemic_state_explicit: true,
      confirmation_basis: {
        ...graph.nodes[0].confirmation_basis,
        confirmed_by: null,
        confirmed_at: null,
      },
    })
    getJson.mockImplementation((url: string) =>
      url.startsWith('/api/preference-conflicts')
        ? Promise.resolve([])
        : Promise.resolve(graph),
    )

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(PersonalProfilePage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeEditDialog: true,
          PreferenceConflictDialog: true,
        },
      },
    })
    await flushPromises()

    const summaryActions = wrapper.findAll('.personal-profile-summary > button')
    expect(summaryActions).toHaveLength(3)
    const pendingAction = summaryActions.find(
      (button) => button.attributes('aria-label') === '查看并处理 1 条待确认偏好',
    )
    expect(pendingAction).toBeDefined()

    await pendingAction!.trigger('click')

    expect(pendingAction!.attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.personal-profile-row')).toHaveLength(1)
    expect(wrapper.get('.personal-profile-row').text()).toContain('全局品味')
    expect(wrapper.get('.personal-profile-row').classes()).toContain('pending-review')
    expect(wrapper.get('.inspector-confirm-action').text()).toBe('确认这条偏好')

    await wrapper.get('.inspector-confirm-action').trigger('click')

    expect(wrapper.get('.knowledge-confirm-dialog').text()).toContain('确认这条偏好')
    expect(wrapper.get('.knowledge-confirm-dialog').text()).toContain('全局品味')
  })

  it('marks preferences whose earlier conflict was resolved by AI', async () => {
    getJson.mockImplementation((url: string) =>
      url.startsWith('/api/preference-conflicts')
        ? Promise.resolve([{
            id: 'resolved-conflict',
            personal_space_id: 'personal-space',
            preference_key: 'global',
            preference_scope: 'global',
            left_item_id: 'global',
            left_item_kind: 'entity',
            right_item_id: 'historical-global',
            right_item_kind: 'entity',
            status: 'resolved',
            requested_by: 'human',
            resolution: 'merge',
            resolved_by: 'agent',
            reason: '使用时交给 AI 判断。',
            resolution_reason: '两条内容互补。',
            deferred_at: '2026-07-29T01:00:00Z',
            resolved_at: '2026-07-29T02:00:00Z',
            updated_at: '2026-07-29T02:00:00Z',
          }])
        : Promise.resolve(profileGraph()),
    )
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(PersonalProfilePage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
          PreferenceConflictDialog: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('.personal-profile-row').text()).toContain(
      '曾冲突 / AI 已处理',
    )
    expect(wrapper.get('.personal-profile-row').classes()).toContain(
      'ai-resolved-conflict',
    )
  })

  it('shows suspected conflicts as explicit A/B decision groups', async () => {
    const graph = profileGraph()
    const older = preferenceNode(
      'conflict-a',
      'Dashboard 视觉规则',
      'taste',
      null,
      '2026-07-24T00:04:00Z',
    )
    older.summary = '宽度工具栏、卡片、水印、筛选排序'
    older.attributes = { preferenceKey: 'dashboard.layout' }
    const newer = preferenceNode(
      'conflict-b',
      'Dashboard 视觉规则',
      'taste',
      null,
      '2026-07-24T00:18:00Z',
    )
    newer.summary = '卡片、宽度、水印、类型高度、全文提示、筛选排序、不透明确认区'
    newer.attributes = { preferenceKey: 'dashboard.layout' }
    graph.nodes.push(older, newer)
    getJson.mockResolvedValue(graph)

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }
    const wrapper = mount(PersonalProfilePage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
          PreferenceConflictDialog: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('.preference-conflict-alert').text()).toContain(
      '发现 1 组疑似冲突',
    )
    expect(wrapper.get('.preference-conflict-alert .primary-action').text()).toBe(
      '查看冲突双方并处理',
    )
    await wrapper.get('.preference-conflict-alert .primary-action').trigger('click')

    expect(wrapper.findAll('.preference-conflict-card')).toHaveLength(1)
    expect(wrapper.text()).toContain('A · 较早记录')
    expect(wrapper.text()).toContain('B · 较新记录')
    expect(wrapper.text()).toContain('B 新增：类型高度、全文提示、不透明确认区')
    expect(wrapper.get('.preference-conflict-card .primary-action').text()).toBe(
      '现在人工处理',
    )
    expect(
      wrapper.get('.preference-conflict-card .secondary-action').text(),
    ).toBe('交给 AI，使用时处理')

    postJson.mockResolvedValue({
      id: 'entity:conflict-a:entity:conflict-b',
      personal_space_id: 'personal-space',
      preference_key: 'dashboard.layout',
      preference_scope: 'global',
      preference_project_id: null,
      left_item_id: 'conflict-a',
      left_item_kind: 'entity',
      right_item_id: 'conflict-b',
      right_item_kind: 'entity',
      status: 'ai_pending',
      requested_by: 'human',
      reason: '用户选择交给 AI，在首次相关使用前判断并处理。',
      deferred_at: '2026-07-29T01:00:00Z',
      updated_at: '2026-07-29T01:00:00Z',
    })
    await wrapper.get('.preference-conflict-card .secondary-action').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/preference-conflicts/defer',
      expect.objectContaining({
        personalSpaceId: 'personal-space',
        preferenceKey: 'dashboard.layout',
        leftItemId: 'conflict-a',
        rightItemId: 'conflict-b',
      }),
    )
    expect(wrapper.get('.preference-conflict-card .secondary-action').text()).toBe(
      '已交给 AI',
    )
    expect(wrapper.text()).toContain('待 AI 使用时判断')
  })
})

function profileGraph() {
  return {
    space_id: 'personal-space',
    nodes: [
      preferenceNode('global', '全局品味', 'taste'),
      preferenceNode('project-a', 'A 项目判断', 'judgment_preference', 'project-a'),
      preferenceNode('project-b', 'B 项目个性', 'personality', 'project-b'),
    ],
    edges: [],
    truncated: false,
  }
}

function preferenceNode(
  id: string,
  name: string,
  profileAspect: string,
  projectId: string | null = null,
  createdAt: string | undefined = undefined,
) {
  return {
    id,
    name,
    type: 'Preference',
    group_id: 'personal',
    summary: `${name}说明`,
    profile_aspect: profileAspect,
    preference_scope: projectId ? 'project' : 'global',
    preference_project_id: projectId,
    attributes: {},
    origin_quadrant: 'known_known',
    confirmation_status: 'confirmed',
    confirmation_state_explicit: true,
    confirmation_basis: {
      existence_reason: '用户明确表达了这条偏好。',
      quadrant_reason: '偏好由用户直接表达。',
      proposed_by: { kind: 'user', label: '用户' },
      confirmed_by: { kind: 'user', label: '用户' },
      confirmed_at: '2026-07-28T10:00:00Z',
    },
    created_at: createdAt,
    evidence: [],
  }
}
