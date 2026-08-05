import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MINIMUM_LOADING_DISPLAY_MS } from '@/composables/useMinimumLoadingDisplay'
import { useConsoleStore } from '@/stores/console'
import type { WritingTasteProfile, WritingTasteRule } from '@/types'

const getJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson }))

import WritingTastePage from './WritingTastePage.vue'

const RouterLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  template: '<a class="router-link-stub" :data-to="to"><slot /></a>',
})
const ConfirmDialogStub = defineComponent({
  props: { item: { type: Object, default: null } },
  template: '<div v-if="item" class="confirm-dialog-stub">{{ item.title }}</div>',
})
const EditDialogStub = defineComponent({
  props: { item: { type: Object, default: null } },
  template: '<div v-if="item" class="edit-dialog-stub">{{ item.title }}</div>',
})

describe('WritingTastePage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getJson.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a collecting profile visible for review without generating an Agent view', async () => {
    const profile = writingTasteProfile('collecting')
    profile.rules = [writingRule('hypothesis', 'Working hypothesis')]
    mockProfileRequests(profile)

    const wrapper = mountPage()
    await finishLoading()

    expect(wrapper.text()).toContain('还在收集写作偏好')
    expect(wrapper.text()).toContain('工作假设')
    expect(wrapper.text()).toContain('可以尝试大胆隐喻')
    expect(wrapper.find('.writing-taste-agent-preview').exists()).toBe(false)

    await wrapper.get('.writing-taste-rule .primary-action').trigger('click')
    expect(wrapper.get('.confirm-dialog-stub').text()).toContain('隐喻偏好')
  })

  it('shows all evidence levels to the user but keeps hypotheses out of Agent rules', async () => {
    const profile = writingTasteProfile('active')
    profile.rules = [
      writingRule('confirmed', 'Confirmed'),
      writingRule('observed', 'Observed'),
      writingRule('hypothesis', 'Working hypothesis'),
    ]
    profile.agent_markdown = [
      '# Agent View',
      '- Confirmed: 先给结论',
      '- Observed: 使用短标题',
    ].join('\n')
    mockProfileRequests(profile)

    const wrapper = mountPage()
    await finishLoading()

    expect(wrapper.findAll('.writing-taste-rule')).toHaveLength(3)
    expect(wrapper.text()).toContain('可以尝试大胆隐喻')

    await wrapper.get('.writing-taste-agent-preview > button').trigger('click')
    const preview = wrapper.get('.writing-taste-agent-preview pre').text()
    expect(preview).toContain('先给结论')
    expect(preview).toContain('使用短标题')
    expect(preview).not.toContain('大胆隐喻')

    const hypothesisCard = wrapper.findAll('.writing-taste-rule')
      .find((card) => card.text().includes('大胆隐喻'))
    await hypothesisCard!.get('.secondary-action').trigger('click')
    expect(wrapper.get('.edit-dialog-stub').text()).toContain('隐喻偏好')
  })
})

function mountPage() {
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
  return mount(WritingTastePage, {
    global: {
      plugins: [pinia],
      stubs: {
        RouterLink: RouterLinkStub,
        KnowledgeConfirmDialog: ConfirmDialogStub,
        KnowledgeEditDialog: EditDialogStub,
      },
    },
  })
}

function mockProfileRequests(profile: WritingTasteProfile) {
  getJson.mockImplementation((url: string) =>
    url.startsWith('/api/writing-taste-profile')
      ? Promise.resolve(profile)
      : Promise.resolve(profileGraph()),
  )
}

async function finishLoading() {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS)
  await flushPromises()
}

function writingTasteProfile(
  status: WritingTasteProfile['status'],
): WritingTasteProfile {
  const ready = status !== 'collecting'
  return {
    status,
    ready,
    generated_at: '2026-08-05T00:00:00.000Z',
    generated_from: 'personal_profile_graph',
    scope: { personal_space_id: 'personal-space', personal_project_id: null },
    readiness: {
      rule_count: ready ? 3 : 1,
      evidence_count: ready ? 6 : 1,
      session_count: ready ? 3 : 1,
      observation_day_count: ready ? 3 : 1,
      confirmed_rule_count: status === 'active' ? 3 : 0,
      observed_rule_count: status === 'preview_ready' ? 3 : 0,
      working_hypothesis_count: status === 'collecting' ? 1 : 0,
      conflict_count: 0,
      standard_path_ready: status === 'preview_ready',
      confirmed_path_ready: status === 'active',
      thresholds: {
        rule_count: 3,
        evidence_count: 6,
        session_count: 3,
        observation_day_count: 3,
        confirmed_rule_count: 3,
      },
      criteria: [
        { key: 'rules', current: ready ? 3 : 1, target: 3, met: ready },
        { key: 'evidence', current: ready ? 6 : 1, target: 6, met: ready },
        { key: 'sessions', current: ready ? 3 : 1, target: 3, met: ready },
        { key: 'days', current: ready ? 3 : 1, target: 3, met: ready },
        { key: 'confirmed', current: status === 'active' ? 3 : 0, target: 3, met: status === 'active' },
        { key: 'conflicts', current: 0, target: 0, met: true },
      ],
    },
    conflicts: [],
    rules: [],
    skill_name: ready ? 'user-writing-taste' : null,
    skill_version: ready ? 'v1:test' : null,
    profile_markdown: ready ? '# User Writing Taste' : null,
    agent_markdown: ready ? '# Agent View' : null,
  }
}

function writingRule(
  id: 'confirmed' | 'observed' | 'hypothesis',
  evidenceStatus: WritingTasteRule['evidence_status'],
): WritingTasteRule {
  const data = {
    confirmed: { title: '结构偏好', instruction: '先给结论' },
    observed: { title: '标题偏好', instruction: '使用短标题' },
    hypothesis: { title: '隐喻偏好', instruction: '可以尝试大胆隐喻' },
  }[id]
  return {
    item_id: id,
    item_kind: 'entity',
    preference_key: `writing.${id}`,
    title: data.title,
    instruction: data.instruction,
    reason: '来自写作反馈。',
    evidence_status: evidenceStatus,
    confirmation_status: evidenceStatus === 'Confirmed'
      ? 'confirmed'
      : evidenceStatus === 'Observed'
        ? 'agent_confirmed'
        : 'pending',
    preference_scope: 'global',
    preference_project_id: null,
    contexts: [],
    evidence: [],
    evidence_count: evidenceStatus === 'Confirmed' ? 1 : 0,
    session_count: 0,
    confirmed_at: evidenceStatus === 'Confirmed' ? '2026-08-05T00:00:00.000Z' : null,
    updated_at: '2026-08-05T00:00:00.000Z',
    origin_quadrant: 'known_known',
    has_conflict: false,
  }
}

function profileGraph() {
  return {
    space_id: 'personal-space',
    nodes: [
      preferenceNode('confirmed', '结构偏好', '先给结论', 'confirmed'),
      preferenceNode('observed', '标题偏好', '使用短标题', 'agent_confirmed'),
      preferenceNode('hypothesis', '隐喻偏好', '可以尝试大胆隐喻', 'pending'),
    ],
    edges: [],
    truncated: false,
  }
}

function preferenceNode(id: string, name: string, summary: string, status: string) {
  return {
    id,
    name,
    summary,
    type: 'WritingTaste',
    group_id: 'personal',
    profile_aspect: 'taste',
    preference_scope: 'global',
    preference_project_id: null,
    origin_quadrant: 'known_known',
    confirmation_status: status,
    confirmation_state_explicit: true,
    confirmation_basis: {
      existence_reason: '来自写作反馈。',
      quadrant_reason: '这是写作偏好。',
      proposed_by: { kind: 'agent', label: 'Agent' },
      confirmed_by: status === 'pending' ? null : { kind: 'user', label: '用户' },
      confirmed_at: status === 'pending' ? null : '2026-08-05T00:00:00.000Z',
    },
    attributes: { tasteDomain: 'writing' },
    evidence: [],
  }
}
