import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import type { KnowledgeGraph, PersonalProject } from '@/types'
import {
  edgeWeightTier,
  extractFrequentProjects,
  filterFormalProjectGraph,
  isFormalProjectNode,
  projectRelationTierLabel,
  resolveProjectRelationWeightTier,
} from './project-relation-weights'

const FALLBACK_CONVERSATION_ID = `conversation-${'a'.repeat(64)}`

function makeProject(project_id: string, name: string, lifecycle = 'active'): PersonalProject {
  return {
    project_id,
    personal_space_id: 'space-1',
    profile: {
      name,
      purpose: `${name} purpose`,
      lifecycle,
    },
  }
}

describe('project relation weights and formal project filtering', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('classifies usage counts into 3 weight tiers (1-2 related, 3-9 frequent, 10+ close)', () => {
    expect(resolveProjectRelationWeightTier({ recent30dCount: 0, totalCount: 0 })).toBeNull()
    expect(resolveProjectRelationWeightTier({ recent30dCount: 1, totalCount: 1 })).toBe('related')
    expect(resolveProjectRelationWeightTier({ recent30dCount: 2, totalCount: 2 })).toBe('related')
    expect(resolveProjectRelationWeightTier({ recent30dCount: 3, totalCount: 3 })).toBe('frequent')
    expect(resolveProjectRelationWeightTier({ recent30dCount: 9, totalCount: 9 })).toBe('frequent')
    expect(resolveProjectRelationWeightTier({ recent30dCount: 10, totalCount: 10 })).toBe('close')
    expect(resolveProjectRelationWeightTier({ tier: 'close', recent30dCount: 1 })).toBe('close')

    expect(projectRelationTierLabel('related')).toBe('有关系')
    expect(projectRelationTierLabel('frequent')).toBe('常往来')
    expect(projectRelationTierLabel('close')).toBe('密切')
  })

  it('filters out conversation fallback, temporary, and archived project nodes and their edges', () => {
    const projects = [
      makeProject('fuli', 'Fuli', 'active'),
      makeProject('archived-proj', 'Archived Project', 'archived'),
    ]
    const graph: KnowledgeGraph = {
      nodes: [
        {
          id: 'personal-project:space-1:fuli',
          name: 'Fuli',
          type: 'PersonalProject',
          attributes: { projectId: 'fuli' },
        },
        {
          id: `personal-project:space-1:${FALLBACK_CONVERSATION_ID}`,
          name: '会话项目',
          type: 'PersonalProject',
          attributes: { projectId: FALLBACK_CONVERSATION_ID },
        },
        {
          id: 'personal-project:space-1:temp-1',
          name: 'Temp Project',
          type: 'RelatedPersonalProject',
          attributes: { projectId: 'temp-1', scope_type: 'temporary' },
        },
        {
          id: 'personal-project:space-1:archived-proj',
          name: 'Archived Project',
          type: 'RelatedPersonalProject',
          attributes: { projectId: 'archived-proj' },
        },
        {
          id: 'personal-project:space-1:archived-attr',
          name: 'Archived By Attr',
          type: 'PersonalProject',
          attributes: { projectId: 'archived-attr', lifecycle: 'archived' },
        },
        {
          id: 'decision-1',
          name: '保留普通知识节点',
          type: 'Decision',
        },
      ],
      edges: [
        {
          id: 'edge-formal-decision',
          source: 'personal-project:space-1:fuli',
          target: 'decision-1',
          type: 'HAS_DECISION',
        },
        {
          id: 'edge-to-fallback',
          source: 'personal-project:space-1:fuli',
          target: `personal-project:space-1:${FALLBACK_CONVERSATION_ID}`,
          type: 'PROJECT_MEMORY_ACCESS',
          attributes: { recent30dCount: 5, totalCount: 5, tier: 'frequent' },
        },
        {
          id: 'edge-to-temp',
          source: 'personal-project:space-1:fuli',
          target: 'personal-project:space-1:temp-1',
          type: 'PROJECT_MEMORY_ACCESS',
          attributes: { recent30dCount: 2, totalCount: 2, tier: 'related' },
        },
        {
          id: 'edge-to-archived',
          source: 'personal-project:space-1:fuli',
          target: 'personal-project:space-1:archived-proj',
          type: 'PROJECT_MEMORY_ACCESS',
          attributes: { recent30dCount: 12, totalCount: 12, tier: 'close' },
        },
      ],
    }

    const filtered = filterFormalProjectGraph(graph, projects)

    expect(filtered.nodes.map(({ id }) => id)).toEqual([
      'personal-project:space-1:fuli',
      'decision-1',
    ])
    expect(filtered.edges.map(({ id }) => id)).toEqual(['edge-formal-decision'])
    expect(isFormalProjectNode(graph.nodes[0], projects)).toBe(true)
    expect(isFormalProjectNode(graph.nodes[1], projects)).toBe(false)
    expect(isFormalProjectNode(graph.nodes[2], projects)).toBe(false)
    expect(isFormalProjectNode(graph.nodes[3], projects)).toBe(false)
    expect(isFormalProjectNode(graph.nodes[4], projects)).toBe(false)
  })

  it('extracts at most 3 formal frequent projects sorted by recent and total usage with reuse suggestion on 10+', () => {
    const projects = [
      makeProject('fuli', 'Fuli'),
      makeProject('alpha', 'Alpha'),
      makeProject('beta', 'Beta'),
      makeProject('gamma', 'Gamma'),
      makeProject('delta', 'Delta'),
      makeProject('archived-x', 'Archived X', 'archived'),
    ]
    const graph: KnowledgeGraph = {
      nodes: [
        {
          id: 'personal-project:space-1:fuli',
          name: 'Fuli',
          type: 'PersonalProject',
          attributes: {
            projectId: 'fuli',
            frequentProjects: [
              { projectId: 'beta', name: 'Beta', recent30dCount: 5, totalCount: 8, tier: 'frequent' },
              { projectId: 'alpha', name: 'Alpha', recent30dCount: 12, totalCount: 15, tier: 'close', suggestKnowledgeReuse: true },
              { projectId: FALLBACK_CONVERSATION_ID, name: '会话项目', recent30dCount: 20, totalCount: 20, tier: 'close' },
              { projectId: 'archived-x', name: 'Archived X', recent30dCount: 18, totalCount: 18, tier: 'close' },
              { projectId: 'gamma', name: 'Gamma', recent30dCount: 2, totalCount: 4, tier: 'related' },
              { projectId: 'delta', name: 'Delta', recent30dCount: 1, totalCount: 2, tier: 'related' },
            ],
          },
        },
      ],
      edges: [],
    }

    const result = extractFrequentProjects(graph, 'fuli', projects)

    expect(result).toHaveLength(3)
    expect(result.map(({ projectId, tier, suggestKnowledgeReuse, grantsAccess }) => ({
      projectId,
      tier,
      suggestKnowledgeReuse,
      grantsAccess,
    }))).toEqual([
      { projectId: 'alpha', tier: 'close', suggestKnowledgeReuse: true, grantsAccess: false },
      { projectId: 'beta', tier: 'frequent', suggestKnowledgeReuse: false, grantsAccess: false },
      { projectId: 'gamma', tier: 'related', suggestKnowledgeReuse: false, grantsAccess: false },
    ])
  })

  it('falls back to outgoing PROJECT_MEMORY_ACCESS edges when node attributes omit frequentProjects', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        {
          id: 'personal-project:space-1:fuli',
          name: 'Fuli',
          type: 'PersonalProject',
          attributes: { projectId: 'fuli' },
        },
        {
          id: 'personal-project:space-1:design-system',
          name: 'Design System',
          type: 'RelatedPersonalProject',
          attributes: { projectId: 'design-system' },
        },
      ],
      edges: [
        {
          id: 'edge-memory-1',
          source: 'personal-project:space-1:fuli',
          target: 'personal-project:space-1:design-system',
          type: 'PROJECT_MEMORY_ACCESS',
          attributes: { recent30dCount: 11, totalCount: 14 },
        },
      ],
    }

    expect(edgeWeightTier(graph.edges[0])).toBe('close')
    const frequent = extractFrequentProjects(graph, 'fuli')
    expect(frequent).toEqual([
      expect.objectContaining({
        projectId: 'design-system',
        name: 'Design System',
        recent30dCount: 11,
        totalCount: 14,
        tier: 'close',
        suggestKnowledgeReuse: true,
        requiresHumanConfirmation: true,
        grantsAccess: false,
      }),
    ])
  })
})
