import { describe, expect, it } from 'vitest'

import type { KnowledgeGraph } from '@/types'
import { separateParentProjects } from './project-hierarchy'

const childNode = {
  id: 'personal-project:child',
  name: '子项目',
  type: 'PersonalProject',
  attributes: { projectId: 'child-project' },
}

const parentNode = {
  id: 'personal-project-related:parent',
  name: '父项目',
  type: 'RelatedPersonalProject',
  summary: '父项目档案',
  attributes: { projectId: 'parent-project' },
}

describe('project hierarchy graph view', () => {
  it('moves an outgoing PART_OF parent out of the active project graph', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        childNode,
        parentNode,
        { id: 'purpose', name: '项目目标', type: 'ProjectPurpose' },
      ],
      edges: [
        {
          id: 'parent-relation',
          source: childNode.id,
          target: parentNode.id,
          type: 'PART_OF',
        },
        {
          id: 'purpose-relation',
          source: childNode.id,
          target: 'purpose',
          type: 'HAS_PURPOSE',
        },
        {
          id: 'secondary-parent-relation',
          source: childNode.id,
          target: parentNode.id,
          type: 'USES_KNOWLEDGE_FROM',
        },
      ],
    }

    const view = separateParentProjects(graph, 'child-project')

    expect(view.parents).toEqual([{
      projectId: 'parent-project',
      name: '父项目',
      summary: '父项目档案',
      nodeId: parentNode.id,
      relationId: 'parent-relation',
    }])
    expect(view.graph.nodes.map(({ id }) => id)).toEqual([childNode.id, 'purpose'])
    expect(view.graph.edges.map(({ id }) => id)).toEqual(['purpose-relation'])
  })

  it('keeps child projects in the graph when the active project is the parent', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        {
          ...childNode,
          id: 'personal-project:parent',
          name: '父项目',
          attributes: { projectId: 'parent-project' },
        },
        {
          ...parentNode,
          id: 'personal-project-related:child',
          name: '子项目',
          attributes: { projectId: 'child-project' },
        },
      ],
      edges: [{
        id: 'child-relation',
        source: 'personal-project-related:child',
        target: 'personal-project:parent',
        type: 'PART_OF',
      }],
    }

    const view = separateParentProjects(graph, 'parent-project')

    expect(view.parents).toEqual([])
    expect(view.graph).toBe(graph)
  })
})
