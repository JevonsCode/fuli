import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import KnowledgeInspector from './KnowledgeInspector.vue'
import { knowledgeItemFromNode } from './model'

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
          session_id: 'cursor-session-7',
        },
      ],
    }
    const wrapper = mount(KnowledgeInspector, {
      props: {
        item: knowledgeItemFromNode(node),
        graph: { nodes: [node], edges: [] },
      },
    })

    expect(wrapper.get('a.evidence-source-action').attributes('href'))
      .toBe('codex://threads/123e4567-e89b-42d3-a456-426614174000')
    expect(wrapper.text()).toContain('Codex · conversation')
    expect(wrapper.text()).toContain('Cursor · conversation')

    await wrapper.get('button.evidence-source-action').trigger('click')
    expect(writeText).toHaveBeenCalledWith('cursor-session-7')
    expect(wrapper.get('button.evidence-source-action').text()).toBe('已复制会话 ID')
  })
})
