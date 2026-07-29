import { describe, expect, it } from 'vitest'

import {
  batchConfirmationBasis,
  batchConfirmationGroups,
  classificationExplanation,
  currentKnowledgeGraph,
  filterKnowledgeItems,
  humanChangeStatusLabel,
  isManagementKnowledgeItem,
  knowledgeReviewState,
  knowledgeItemFromNode,
  knowledgeItems,
  managementKnowledgeItems,
  mergeKnowledgeGraphs,
  personalProjectIdForItem,
  projectMaterialTypeLabel,
  quadrantLabel,
  reviewStateLabel,
} from './model'

describe('knowledge model', () => {
  it('keeps historical content in the directory and removes it from the current graph', () => {
    const graph = {
      nodes: [
        { id: 'a', name: 'Current', type: 'Decision' },
        { id: 'b', name: 'Historical', type: 'Decision', invalid_at: '2026-01-01' },
      ],
      edges: [
        { id: 'edge-1', source: 'a', target: 'b', type: 'RELATED_TO' },
      ],
    }

    expect(knowledgeItems(graph)).toHaveLength(3)
    expect(currentKnowledgeGraph(graph)).toEqual({
      ...graph,
      nodes: [graph.nodes[0]],
      edges: [],
    })
  })

  it('merges project context without duplicating evidence', () => {
    const merged = mergeKnowledgeGraphs([
      {
        nodes: [{
          id: 'a',
          name: 'Rule',
          type: 'Decision',
          evidence: [{ id: 'source-1', name: 'Session' }],
        }],
        edges: [],
      },
      {
        nodes: [{
          id: 'a',
          name: 'Rule',
          type: 'Decision',
          evidence: [{ id: 'source-1', name: 'Session' }],
        }],
        edges: [],
      },
    ])

    expect(merged.nodes).toHaveLength(1)
    expect(merged.nodes[0].evidence).toHaveLength(1)
  })

  it('keeps project nodes out of the directory but available to graph actions', () => {
    const node = {
      id: 'personal-project:space-1:project-1',
      name: 'Project one',
      type: 'PersonalProject',
      attributes: { projectId: 'project-1' },
    }
    const item = knowledgeItemFromNode(node)

    expect(knowledgeItems({ nodes: [node], edges: [] })).toEqual([])
    expect(isManagementKnowledgeItem(item)).toBe(true)
    expect(personalProjectIdForItem(item)).toBe('project-1')
  })

  it('exposes project profile projections as a separate directory section', () => {
    const graph = {
      nodes: [
        {
          id: 'project-profile:project-1:purpose',
          name: '项目目标',
          type: 'ProjectPurpose',
          summary: '解释项目为什么存在。',
        },
        {
          id: 'project-profile:project-1:technical-summary',
          name: '技术说明',
          type: 'TechnicalSummary',
          summary: '项目采用的技术方案。',
        },
      ],
      edges: [{
        id: 'project-profile-edge:project-1:purpose',
        source: 'personal-project:space-1:project-1',
        target: 'project-profile:project-1:purpose',
        type: 'HAS_PURPOSE',
        fact: '项目具备明确目标。',
      }],
    }

    expect(knowledgeItems(graph)).toEqual([])
    expect(managementKnowledgeItems(graph).map(({ id }) => id)).toEqual([
      'project-profile:project-1:purpose',
      'project-profile:project-1:technical-summary',
      'project-profile-edge:project-1:purpose',
    ])
    expect(projectMaterialTypeLabel(managementKnowledgeItems(graph)[0])).toBe('项目目标')
    expect(projectMaterialTypeLabel(managementKnowledgeItems(graph)[1])).toBe('技术说明')
    expect(projectMaterialTypeLabel(managementKnowledgeItems(graph)[2])).toBe('项目资料关系')
  })

  it('does not present legacy missing metadata as confirmed known knowledge', () => {
    const item = knowledgeItemFromNode({
      id: 'legacy',
      name: 'Legacy item',
      type: 'Decision',
      origin_quadrant: 'known_known',
      current_quadrant: 'known_known',
      epistemic_status: 'confirmed',
      epistemic_state_explicit: false,
    })

    expect(item.classificationExplicit).toBe(false)
    expect(item.currentQuadrant).toBe('unclassified')
    expect(item.epistemicStatus).toBe('unreviewed')
    expect(item.confirmationStatus).toBe('pending')
    expect(quadrantLabel(item.currentQuadrant)).toBe('待分类')
    expect(reviewStateLabel(item)).toBe('待确认')
    expect(classificationExplanation(item)).toContain('不会自动归入')
  })

  it('keeps human edits searchable after Agent review while only pending versions stay marked', () => {
    const unseen = knowledgeItemFromNode({
      id: 'human-unseen',
      name: 'Unseen edit',
      type: 'Decision',
      human_edited: true,
      human_change_status: 'unseen',
      human_change_version: 2,
      audit_events: [{
        id: 'audit-1',
        item_id: 'human-unseen',
        item_kind: 'entity',
        action: 'human_change',
        human_change_version: 2,
        reason: '人工修正了分类',
        created_at: '2026-07-28T07:00:00Z',
      }],
    })
    const reviewed = knowledgeItemFromNode({
      id: 'human-reviewed',
      name: 'Reviewed edit',
      type: 'Decision',
      human_edited: true,
      human_change_status: 'reviewed',
      human_change_version: 1,
    })

    expect(humanChangeStatusLabel(unseen.humanChangeStatus)).toContain('Agent 未查看')
    expect(filterKnowledgeItems([unseen, reviewed], {
      humanChange: 'human_changed',
    })).toHaveLength(2)
    expect(filterKnowledgeItems([unseen, reviewed], {
      humanChange: 'unseen',
    })).toEqual([unseen])
    expect(filterKnowledgeItems([unseen, reviewed], {
      query: '人工修正',
    })).toEqual([unseen])
  })

  it('treats a legacy confirmed flag without an auditable confirmer as pending', () => {
    const item = knowledgeItemFromNode({
      id: 'explicit-without-evidence',
      name: 'Explicit item',
      type: 'Decision',
      origin_quadrant: 'known_known',
      current_quadrant: 'known_known',
      epistemic_status: 'confirmed',
      epistemic_state_explicit: true,
      evidence: [],
      revisions: [],
    })

    expect(knowledgeReviewState(item)).toBe('pending')
    expect(reviewStateLabel(item)).toBe('待确认')
    expect(classificationExplanation(item)).toContain('没有结构化的确认人和确认时间')
  })

  it('keeps the discovery quadrant after an auditable confirmation', () => {
    const item = knowledgeItemFromNode({
      id: 'confirmed-tacit-knowledge',
      name: 'Low-saturation preference',
      type: 'DesignTaste',
      origin_quadrant: 'unknown_known',
      current_quadrant: 'known_known',
      epistemic_status: 'confirmed',
      epistemic_state_explicit: true,
      confirmation_status: 'confirmed',
      confirmation_state_explicit: true,
      confirmation_basis: {
        existence_reason: 'Repeated feedback rejected saturated palettes.',
        quadrant_reason: 'The preference was inferred before it was articulated.',
        proposed_by: { kind: 'agent', label: 'Codex' },
        confirmed_by: { kind: 'user' },
        confirmed_at: '2026-07-24T03:00:00+08:00',
      },
    })

    expect(item.originQuadrant).toBe('unknown_known')
    expect(knowledgeReviewState(item)).toBe('confirmed')
    expect(reviewStateLabel(item)).toBe('已确认')
    expect(classificationExplanation(item)).toContain('同时覆盖知识内容和象限归类')
  })

  it('recognizes only policy-backed Agent confirmation and exposes its usage scores', () => {
    const item = knowledgeItemFromNode({
      id: 'agent-confirmed-runbook',
      name: 'Deployment runbook',
      type: 'Runbook',
      origin_quadrant: 'known_known',
      current_quadrant: 'known_known',
      epistemic_state_explicit: true,
      confirmation_status: 'agent_confirmed',
      confirmation_state_explicit: true,
      confirmation_basis: {
        existence_reason: 'Repeated material use supported this runbook.',
        quadrant_reason: 'It was explicitly expressed when captured.',
        proposed_by: { kind: 'agent', label: 'Codex' },
        confirmed_by: { kind: 'agent', label: 'Fuli usage policy' },
        confirmed_at: '2026-07-29T03:00:00Z',
        agent_policy_version: 'agent-usage-v1',
      },
      utility_score: 0.72,
      confidence_score: 0.74,
      qualified_use_count: 5,
      distinct_task_count: 3,
    })

    expect(knowledgeReviewState(item)).toBe('agent_confirmed')
    expect(reviewStateLabel(item)).toBe('Agent 已确认')
    expect(item.utilityScore).toBe(0.72)
    expect(item.confidenceScore).toBe(0.74)
    expect(item.qualifiedUseCount).toBe(5)
    expect(item.distinctTaskCount).toBe(3)
    expect(classificationExplanation(item)).toContain('低于人工或权威来源确认')

    item.confirmationBasis!.agent_policy_version = undefined
    expect(knowledgeReviewState(item)).toBe('pending')
  })

  it('groups only pending classified knowledge by exact source and session', () => {
    const evidence = {
      id: 'episode-1',
      name: 'Approved discussion',
      source_description: 'The user reviewed the project direction.',
      source_application: 'codex',
      session_id: 'session-1',
    }
    const pending = ['a', 'b'].map((id) => knowledgeItemFromNode({
      id,
      name: `Pending ${id}`,
      type: 'Decision',
      origin_quadrant: 'known_known',
      current_quadrant: 'known_known',
      epistemic_status: 'observed',
      epistemic_state_explicit: true,
      confirmation_status: 'pending',
      confirmation_state_explicit: true,
      evidence: [evidence],
    }))
    const unclassified = knowledgeItemFromNode({
      id: 'legacy',
      name: 'Legacy',
      type: 'Decision',
      evidence: [evidence],
    })

    const groups = batchConfirmationGroups([...pending, unclassified])

    expect(groups).toHaveLength(2)
    expect(groups.map(({ kind }) => kind).sort()).toEqual(['session', 'source'])
    expect(groups.every(({ items }) => items.length === 2)).toBe(true)
  })

  it('builds an inspectable per-item basis from the selected evidence group', () => {
    const item = knowledgeItemFromNode({
      id: 'a',
      name: 'Pending',
      type: 'Decision',
      origin_quadrant: 'known_unknown',
      current_quadrant: 'known_unknown',
      epistemic_status: 'observed',
      epistemic_state_explicit: true,
      confirmation_status: 'pending',
      confirmation_state_explicit: true,
      evidence: [{
        id: 'episode-1',
        name: 'Design review',
        source_description: 'The tradeoff was raised during design review.',
        source_application: 'codex',
      }],
    })

    expect(batchConfirmationBasis(item, {
      kind: 'source',
      value: 'episode-1',
      label: 'Design review',
    })).toEqual({
      existenceReason: 'The tradeoff was raised during design review.',
      quadrantReason: '该内容在发现时符合“已知的未知”：被明确提出、但仍在等待答案的问题。',
      proposedBy: { kind: 'agent', label: 'Codex' },
    })
  })
})
