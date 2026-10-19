import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import type { AgentConfirmationProgress, KnowledgeNode } from '@/types'

import KnowledgeInspector from './KnowledgeInspector.vue'
import { knowledgeItemFromNode } from './model'

function synthetic(overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: 'synthetic-candidate',
    name: 'Synthetic candidate',
    type: 'Requirement',
    summary: 'Synthetic fixture only.',
    origin_quadrant: 'known_known',
    epistemic_state_explicit: true,
    confirmation_status: 'pending',
    confirmation_state_explicit: false,
    ...overrides,
  } as KnowledgeNode
}

function progress(
  overrides: Partial<AgentConfirmationProgress> = {},
): AgentConfirmationProgress {
  return {
    required_qualified_uses: 7,
    required_distinct_tasks: 4,
    qualified_use_count: 3,
    distinct_task_count: 2,
    has_open_conflict: false,
    blocking_reasons: ['qualified_uses_below_threshold', 'distinct_tasks_below_threshold'],
    ...overrides,
  }
}

function inspect(node: KnowledgeNode) {
  const wrapper = mount(KnowledgeInspector, {
    props: { item: knowledgeItemFromNode(node), graph: { nodes: [node], edges: [] } },
  })
  const row = (selector: string) =>
    wrapper.find(selector).exists() ? wrapper.get(`${selector} dd`).text() : null
  return {
    wrapper,
    progress: row('.inspector-auto-confirmation'),
    reason: row('.inspector-auto-confirmation-reason'),
  }
}

describe('agent confirmation progress in the candidate inspector', () => {
  it('keeps missing thresholds and blocking reasons unknown without crashing or inventing zero', () => {
    const view = inspect(synthetic({ agent_confirmation_progress: progress({ required_qualified_uses: undefined as never, required_distinct_tasks: undefined as never, blocking_reasons: undefined as never }) }))
    expect(view.progress).toContain('有效使用 3 / 未知')
    expect(view.reason).toContain('未知')
    expect(view.reason).not.toContain('条件已满足')
  })
  afterEach(() => setLocale('zh-CN', { persist: false }))

  it('shows the counts and thresholds the Provider returned, without percentages', () => {
    const view = inspect(synthetic({ agent_confirmation_progress: progress() }))

    expect(view.progress).toBe('有效使用 3 / 7 次 · 不同任务 2 / 4 个')
    expect(view.reason).toBe('有效使用次数未达阈值；不同任务数未达阈值')
    expect(`${view.progress}${view.reason}`).not.toContain('%')
  })

  it('keeps unknown counts unknown instead of showing zero', () => {
    const view = inspect(synthetic({
      qualified_use_count: 0,
      distinct_task_count: 0,
      agent_confirmation_progress: progress({
        qualified_use_count: null,
        distinct_task_count: null,
        blocking_reasons: ['usage_unknown'],
      }),
    }))

    expect(view.progress).toBe('有效使用 未知 / 7 次 · 不同任务 未知 / 4 个')
    expect(view.reason).toBe('使用记录未知，无法判断是否达到阈值')
    expect(view.wrapper.text()).toContain('有效使用未知 次 / 未知 个任务')
    expect(view.wrapper.text()).not.toContain('0 次 / 0 个任务')
  })

  it('says progress is unknown when the service did not return it', () => {
    const view = inspect(synthetic({ qualified_use_count: 0, distinct_task_count: 0 }))

    expect(view.progress).toBe('未知：当前服务未返回自动确认进度')
    expect(view.reason).toBe('未知：当前服务未返回阻止原因')
  })

  it('names an open conflict as the actual blocker', () => {
    const view = inspect(synthetic({
      agent_confirmation_progress: progress({
        qualified_use_count: 9,
        distinct_task_count: 5,
        has_open_conflict: true,
        blocking_reasons: ['open_conflict'],
      }),
    }))

    expect(view.reason).toBe('有未解决的冲突，解决前不会自动确认')
  })

  it('says a rejected item needs the person, not more uses, even past the thresholds', () => {
    const view = inspect(synthetic({
      agent_confirmation_progress: progress({
        qualified_use_count: 10,
        distinct_task_count: 8,
        blocking_reasons: ['negative_feedback_block'],
      }),
    }))

    expect(view.reason).toBe('你或权威来源否定过这条，使用次数不会让它自动恢复；只有你明确确认才能恢复')
    expect(view.reason).not.toContain('条件已满足')
  })

  it('states that conditions are met without claiming the item is already confirmed', () => {
    setLocale('en-US', { persist: false })
    const view = inspect(synthetic({
      agent_confirmation_progress: progress({
        qualified_use_count: 7,
        distinct_task_count: 4,
        blocking_reasons: [],
      }),
    }))

    expect(view.progress).toBe('Material uses 7 / 7 · distinct tasks 4 / 4')
    expect(view.reason).toContain('next recorded material use')
  })

  it('leaves human-confirmed and Agent-confirmed knowledge on their existing labels', () => {
    const confirmed = inspect(synthetic({
      confirmation_status: 'confirmed',
      confirmation_state_explicit: true,
      confirmation_basis: {
        existence_reason: 'Synthetic.',
        quadrant_reason: 'Synthetic.',
        proposed_by: { kind: 'agent' },
        confirmed_by: { kind: 'user' },
        confirmed_at: '2026-10-17T00:00:00Z',
      },
      agent_confirmation_progress: progress({ blocking_reasons: ['not_pending'] }),
    }))
    const agentConfirmed = inspect(synthetic({
      confirmation_status: 'agent_confirmed',
      confirmation_state_explicit: true,
      confirmation_basis: {
        existence_reason: 'Synthetic.',
        quadrant_reason: 'Synthetic.',
        proposed_by: { kind: 'agent' },
        confirmed_by: { kind: 'agent', label: 'Fuli usage policy' },
        confirmed_at: '2026-10-17T00:00:00Z',
        agent_policy_version: 'agent-usage-v1',
      },
      agent_confirmation_progress: progress({ blocking_reasons: ['not_pending'] }),
    }))

    for (const view of [confirmed, agentConfirmed]) {
      expect(view.progress).toBeNull()
      expect(view.reason).toBeNull()
    }
    expect(confirmed.wrapper.text()).toContain('已确认')
    expect(agentConfirmed.wrapper.text()).toContain('Agent 已确认')
  })
})
