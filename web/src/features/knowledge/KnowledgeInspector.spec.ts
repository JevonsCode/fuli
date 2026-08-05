import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeInspector from './KnowledgeInspector.vue'
import { knowledgeItemFromNode } from './model'
import { DEFAULT_CONVERSATION_LAUNCHERS } from './source-adapters'

describe('KnowledgeInspector', () => {
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
    expect(confirm.classes()).toContain('primary-action')

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
    expect(wrapper.text()).toContain('不是可独立确认、失效或恢复的知识记录')

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
    expect(relation.get('.relation-type').text()).toBe('HAS_TECHNICAL_SUMMARY')
    expect(relation.get('.relation-target').text()).toBe('当前技术边界与待确认事项。')
    wrapper.unmount()
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
    expect(wrapper.get('.inspector-replacement').text()).toContain('不会根据文字猜测链接')
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
