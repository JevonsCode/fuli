import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeInspector from './KnowledgeInspector.vue'
import { knowledgeItemFromNode } from './model'
import { DEFAULT_CONVERSATION_LAUNCHERS } from './source-adapters'

describe('KnowledgeInspector', () => {
  it('preserves relationship evidence, revision, audit and unknown source keys without unsafe links', async () => {
    const raw = { id: 'same', source: 'a', target: 'b', type: 'PREFERS', fact: 'FACT-SENTINEL', profile_aspect: 'taste', preference_scope: 'global', source_extra: 'UNKNOWN-RAW', evidence: [{ id: 'E-ID', name: 'E-NAME', summary: 'E-SUMMARY', source_description: 'E-DESCRIPTION', source_excerpt: 'E-LONG'.repeat(2000), source_uri: 'javascript:alert(1)', session_id: 'not a legal session!', source_turn_id: 'TURN', personal_project_id: 'P-PROJECT', unknown: 'E-UNKNOWN' }], revisions: [{ id: 'R', reason: 'REV', extra: 'REV-UNKNOWN' }], audit_events: [{ id: 'A', reason: 'AUDIT', extra: 'AUDIT-UNKNOWN' }], assignments: [{ extra: 'ASSIGNMENT' }], project_references: [{ extra: 'PROJECT-REF' }], conflicts: [{ extra: 'CONFLICT' }] }
    const { knowledgeItemFromEdge } = await import('./model')
    const wrapper = mount(KnowledgeInspector, { props: { mode: 'preference', item: knowledgeItemFromEdge(raw as never, new Map()), graph: { nodes: [], edges: [raw as never] }, editable: true } })
    expect(wrapper.get('[data-raw-record]').text()).toBe(JSON.stringify(raw, null, 2))
    expect(wrapper.findAll('a').some(a => a.attributes('href')?.startsWith('javascript:'))).toBe(false)
    expect(wrapper.find('a.evidence-source-action').exists()).toBe(false)
    expect(wrapper.get('[data-preference-records]').text()).toContain('E-DESCRIPTION')
    expect(wrapper.get('.evidence-excerpt').text()).toHaveLength(12000)
    wrapper.unmount()
  })

  it.each([
    { epistemic_state_explicit: false },
    { invalid_at: '2026-10-18' },
    { type: 'ProjectPurpose' },
  ])('does not expand confirmation eligibility for legacy, history or projection input %j', overrides => {
    const raw = { id: 'synthetic', name: 'Synthetic', type: 'Preference', profile_aspect: 'taste', epistemic_state_explicit: true, ...overrides }
    const wrapper = mount(KnowledgeInspector, { props: { mode: 'preference', item: knowledgeItemFromNode(raw), graph: { nodes: [raw], edges: [] }, editable: true } })
    expect(wrapper.find('.inspector-confirm-action').exists()).toBe(false)
    wrapper.unmount()
  })
  it('offers the explicit preference summary before independently collapsed basis and complete records', async () => {
    const node = { id: 'synthetic', name: 'Synthetic title sentinel', type: 'Preference', summary: 'Body sentinel', profile_aspect: 'taste', preference_scope: 'global', epistemic_state_explicit: true, confirmation_status: 'pending', evidence: [{ name: 'E-name', summary: 'E-summary', source_description: 'E-description', source_excerpt: 'E-excerpt', custom: 'E-unknown' }], revisions: [{ reason: 'R-reason', unknown: 'R-unknown' }], attributes: { secret: 'A-sentinel' } }
    const wrapper = mount(KnowledgeInspector, { props: { item: knowledgeItemFromNode(node), graph: { nodes: [node], edges: [] }, editable: true, mode: 'preference', preferenceScopeLabel: '个人全局' } })
    expect(wrapper.findAll('.preference-detail .ui-disclosure')).toHaveLength(2)
    expect(wrapper.findAll('.preference-detail .ui-disclosure[open]')).toHaveLength(0)
    expect(wrapper.find('.inspector-classification').exists()).toBe(false)
    expect(wrapper.find('h3').exists()).toBe(false)
    expect(wrapper.get('.preference-summary').text()).toContain('Body sentinel')
    expect(wrapper.find('.inspector-confirm-action').exists()).toBe(true)
    // The evidence count is the records disclosure's own title, not a second jump link.
    expect(wrapper.find('[data-evidence-jump]').exists()).toBe(false)
    expect(wrapper.get('[data-preference-records] summary').text()).toBe('原始证据与记录（1 条证据）')
    for (const sentinel of ['E-name', 'E-summary', 'E-description', 'E-excerpt', 'E-unknown', 'R-reason', 'R-unknown', 'A-sentinel']) expect(wrapper.get('[data-preference-records]').text()).toContain(sentinel)
    expect(wrapper.get('[data-preference-records] pre[data-raw-record]').text()).toBe(JSON.stringify(node, null, 2))
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it.each(['pending', 'confirmed', 'agent_confirmed', 'ai_reviewed'])('preserves %s confirmation eligibility in preference mode', state => {
    const node = { id: 'synthetic', name: 'Synthetic', type: 'Preference', profile_aspect: 'taste', epistemic_state_explicit: true, confirmation_state_explicit: true, confirmation_status: state, ai_assessment: state === 'ai_reviewed' ? { outcome: 'approve' as const, summary: 'Synthetic AI review', evidence: [], confidence: 0.8 } : null, ai_review_evidence_token: state === 'ai_reviewed' ? 'synthetic-token' : null, confirmation_basis: { existence_reason: 'basis', quadrant_reason: 'quadrant', proposed_by: { kind: 'user', label: 'Synthetic' }, confirmed_by: { kind: state === 'agent_confirmed' ? 'agent' : 'user' }, confirmed_at: '2026-10-18T10:00:00Z', agent_policy_version: 'v1' } }
    const wrapper = mount(KnowledgeInspector, { props: { item: knowledgeItemFromNode(node), graph: { nodes: [node], edges: [] }, editable: true, mode: 'preference' } })
    expect(wrapper.find('.inspector-confirm-action').exists()).toBe(state === 'pending')
  })
  it('exposes confirmation as the primary action for pending knowledge', async () => {
    const node = {
      id: 'preference-1',
      name: '使用干净的实心选中态',
      type: 'DesignTaste',
      summary: '避免齿轮状、虚线或点状选中环。',
      origin_quadrant: 'known_known',
      epistemic_state_explicit: true,
      confirmation_status: 'pending',
      confirmation_state_explicit: false,
      profile_aspect: 'taste',
    }
    const item = knowledgeItemFromNode(node)
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item,
        graph: { nodes: [node], edges: [] },
        editable: true,
        mode: 'directory',
      },
    })

    const confirm = wrapper.get('.inspector-confirm-action')
    expect(confirm.text()).toBe('确认这条偏好')
    expect(confirm.attributes('data-variant')).toBe('default')

    await confirm.trigger('click')
    expect(wrapper.emitted('confirm')).toEqual([[item]])
  })

  it('treats project-profile nodes as editable project material, not status-flippable knowledge', async () => {
    const node = {
      id: 'project-profile:project-1:purpose',
      name: '项目目标',
      type: 'ProjectPurpose',
      summary: '项目存在的原因。',
    }
    const item = knowledgeItemFromNode(node)
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item,
        graph: { nodes: [node], edges: [] },
        editable: true,
        currentProjectId: 'project-1',
        canManageProject: true,
        mode: 'graph',
      },
    })

    expect(wrapper.find('.inspector-project-material').exists()).toBe(true)
    expect(wrapper.find('.inspector-classification').exists()).toBe(false)
    expect(wrapper.find('.inspector-confirmation-basis').exists()).toBe(false)
    expect(wrapper.text()).toContain('修改请编辑项目资料')

    const actions = wrapper.findAll('.inspector-actions button')
    expect(actions.map((button) => button.text())).toContain('编辑项目资料')
    expect(actions.map((button) => button.text())).toContain('在内容目录中定位')

    await actions.find((button) => button.text() === '编辑项目资料')?.trigger('click')
    await actions.find((button) => button.text() === '在内容目录中定位')?.trigger('click')
    expect(wrapper.emitted('manageProject')).toEqual([[item]])
    expect(wrapper.emitted('openDirectory')).toEqual([[item]])
  })

  it('shows projected external sources as read-only project material', () => {
    const node = {
      id: 'external-knowledge-source:binding-1',
      name: 'LLM Wiki',
      type: 'ExternalKnowledgeSource',
      summary: 'Read-only MCP knowledge source.',
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node], edges: [] },
        editable: true,
        currentProjectId: 'project-1',
        canManageProject: true,
        mode: 'graph',
      },
    })

    const actions = wrapper.findAll('.inspector-actions button').map((button) => button.text())
    expect(actions).not.toContain('编辑项目资料')
    expect(actions).toContain('在内容目录中定位')
  })

  it('presents each related edge as a title followed by full-width content', () => {
    const node = {
      id: 'project-1',
      name: 'AICG',
      type: 'PersonalProject',
      summary: '项目资料',
    }
    const relatedNode = {
      id: 'technical-summary-1',
      name: '技术摘要',
      type: 'ProjectTechnicalSummary',
    }
    const edge = {
      id: 'relation-1',
      source: node.id,
      target: relatedNode.id,
      type: 'HAS_TECHNICAL_SUMMARY',
      fact: '当前技术边界与待确认事项。',
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node, relatedNode], edges: [edge] },
      },
    })

    const relation = wrapper.get('.inspector-relation')
    expect(relation.element.children[0]?.tagName).toBe('STRONG')
    expect(relation.element.children[1]?.tagName).toBe('P')
    expect(relation.get('.relation-type').text()).toBe('技术说明')
    expect(relation.get('.relation-type').attributes('title')).toBe('HAS_TECHNICAL_SUMMARY')
    expect(relation.get('.relation-target').text()).toBe('当前技术边界与待确认事项。')
    wrapper.unmount()
  })

  it('puts delete one click away on the item and on each of its facts, only in the console (D-88)', () => {
    const node = { id: 'synthetic-node', name: 'Synthetic', type: 'Concept', summary: 'Synthetic body' }
    const other = { id: 'synthetic-other', name: 'Other', type: 'Concept' }
    const edge = { id: 'synthetic-edge', source: node.id, target: other.id, type: 'RELATES_TO', fact: 'Synthetic fact' }
    const props = { item: knowledgeItemFromNode(node), graph: { nodes: [node, other], edges: [edge] }, editable: true }
    const wrapper = mount(KnowledgeInspector, { props: { ...props, spaceId: 'space' } })
    expect(wrapper.findAll('.inspector-relation [data-hard-delete-open]')).toHaveLength(1)
    expect(wrapper.findAll('.inspector-actions [data-hard-delete-open]')).toHaveLength(1)
    expect(wrapper.get('.inspector-actions [data-hard-delete-open]').text()).toBe('删除…')
    wrapper.unmount()
    // Without the console's space, or for a project node, nothing offers it.
    const noSpace = mount(KnowledgeInspector, { props })
    expect(noSpace.find('[data-hard-delete-open]').exists()).toBe(false)
    noSpace.unmount()
    const project = { ...node, type: 'PersonalProject' }
    const projectView = mount(KnowledgeInspector, { props: { ...props, item: knowledgeItemFromNode(project), spaceId: 'space' } })
    expect(projectView.find('.inspector-actions [data-hard-delete-open]').exists()).toBe(false)
    projectView.unmount()
  })

  it('names the exact project in a project-scoped preference detail', () => {
    const preference = {
      id: 'preference-project-scope',
      name: '隐藏局部操作时不保留装饰分隔线',
      type: 'DesignTaste',
      summary: '不保留孤立分隔线。',
      profile_aspect: 'taste',
      preference_scope: 'project',
      preference_project_id: 'fuli',
    }
    const project = {
      id: 'personal-project:space-1:fuli',
      name: '复利（Fuli）',
      type: 'PersonalProject',
      attributes: { projectId: 'fuli' },
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(preference),
        graph: { nodes: [preference, project], edges: [] },
      },
    })

    expect(wrapper.text()).toContain('指定项目 · 复利（Fuli） (fuli)')
  })

  it('shows the exact replacement for historical knowledge and emits a direct jump', async () => {
    const replacement = {
      id: 'requirement-current',
      name: '当前交付口径',
      type: 'Requirement',
      summary: '这是替代旧口径的当前内容。',
    }
    const historical = {
      id: 'requirement-old',
      name: '旧交付口径',
      type: 'Requirement',
      summary: '已经失效的旧内容。',
      invalid_at: '2026-07-23T08:00:00Z',
      replaced_by_item_id: replacement.id,
      replaced_by_item_kind: 'entity' as const,
    }
    const replacementItem = knowledgeItemFromNode(replacement)
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(historical),
        graph: { nodes: [historical, replacement], edges: [] },
        mode: 'directory',
      },
    })

    expect(wrapper.get('.inspector-replacement').text()).toContain('已被以下内容取代')
    expect(wrapper.get('.inspector-replacement-link').text()).toContain('当前交付口径')

    await wrapper.get('.inspector-replacement-link').trigger('click')
    expect(wrapper.emitted('openReplacement')).toEqual([[replacementItem]])
  })

  it('does not invent a jump when a historical record has no replacement id', () => {
    const historical = {
      id: 'requirement-old',
      name: '旧交付口径',
      type: 'Requirement',
      summary: '只有失效原因。',
      invalid_at: '2026-07-23T08:00:00Z',
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(historical),
        graph: { nodes: [historical], edges: [] },
      },
    })

    expect(wrapper.find('.inspector-replacement-link').exists()).toBe(false)
    expect(wrapper.get('.inspector-replacement').text()).toContain('没有替代项')
  })

  it('opens exact Codex evidence and copies non-Codex source identities', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const node = {
      id: 'decision-1',
      name: '发布需审核',
      type: 'Decision',
      evidence: [
        {
          id: 'codex-source',
          source_application: 'codex',
          source_kind: 'conversation',
          session_id: '123e4567-e89b-42d3-a456-426614174000',
        },
        {
          id: 'cursor-source',
          source_application: 'cursor',
          source_kind: 'conversation',
          session_id: 'cursor-session/7',
        },
      ],
    }
    const conversationLaunchers = structuredClone(DEFAULT_CONVERSATION_LAUNCHERS)
    conversationLaunchers.cursor = {
      enabled: true,
      idFormat: 'any',
      appName: 'Cursor',
      urlTemplate: 'cursor://conversation/{id}',
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node], edges: [] },
        conversationLaunchers,
      },
    })

    const links = wrapper.findAll('a.evidence-source-action')
    expect(links.map((link) => link.attributes('href'))).toEqual([
      'codex://threads/123e4567-e89b-42d3-a456-426614174000',
      'cursor://conversation/cursor-session%2F7',
    ])
    expect(wrapper.text()).toContain('Codex · conversation')
    expect(wrapper.text()).toContain('Cursor · conversation')
    expect(wrapper.findAll('.evidence-source-actions')).toHaveLength(2)
    expect(wrapper.findAll('button.evidence-source-action')).toHaveLength(2)

    await wrapper.findAll('button.evidence-source-action')[1]?.trigger('click')
    expect(writeText).toHaveBeenCalledWith('cursor-session/7')
    expect(wrapper.findAll('button.evidence-source-action')[1]?.text()).toBe('已复制会话 ID')
  })

  it('does not render a dead Codex link for a non-native session ID', () => {
    const node = {
      id: 'decision-unsupported-codex',
      name: '无法定位的会话',
      type: 'Decision',
      evidence: [{
        id: 'codex-source',
        source_application: 'codex',
        source_kind: 'conversation',
        session_id: 'codex-fuli-ui-status-dedup-20260723',
      }],
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node], edges: [] },
      },
    })

    expect(wrapper.find('a.evidence-source-action').exists()).toBe(false)
    expect(wrapper.findAll('button.evidence-source-action')).toHaveLength(1)
    expect(wrapper.findAll('button.evidence-source-action')[0]?.text()).toBe('复制会话 ID')
  })

  it('does not render source actions when evidence has no stored session ID', () => {
    const node = {
      id: 'decision-without-session-id',
      name: '没有会话 ID 的证据',
      type: 'Decision',
      evidence: [{
        id: 'source-without-session-id',
        source_application: 'codex',
        source_kind: 'conversation',
      }],
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node], edges: [] },
      },
    })

    expect(wrapper.find('.evidence-source-actions').exists()).toBe(false)
  })
})
