import { describe, expect, it } from 'vitest'

import {
  dropTargetAt,
  dropTargetAttribute,
  projectTree,
  resolveProjectDrop,
  searchMoveTargets,
} from './project-organize'
import type { KnowledgeGraph } from '@/types'

const project = (id: string) => ({
  id: `personal-project:${id}`, name: `Synthetic ${id}`, type: 'PersonalProject', attributes: { projectId: id },
})
const partOf = (child: string, parent: string, status = 'active', invalid_at: string | null = null) => ({
  id: `${child}-${parent}`, source: `personal-project:${child}`, target: `personal-project:${parent}`,
  type: 'PART_OF', attributes: { status }, invalid_at,
})

// platform > app > mobile; docs and tools top level; app was once under docs.
const graph: KnowledgeGraph = {
  nodes: [project('platform'), project('app'), project('mobile'), project('docs'), project('tools'),
    { id: 'knowledge', name: 'Synthetic note', type: 'Decision' }],
  edges: [
    partOf('app', 'platform'),
    partOf('mobile', 'app'),
    partOf('app', 'docs', 'rejected', '2026-10-01T00:00:00Z'),
    partOf('tools', 'docs', 'pending'),
    { id: 'related', source: 'personal-project:app', target: 'personal-project:tools', type: 'RELATED_TO',
      attributes: { status: 'active' } },
  ],
}

describe('project organize rules', () => {
  const tree = projectTree(graph)

  it('reads each project\'s parent from its active PART_OF relation only', () => {
    expect(tree.projects.map(({ projectId }) => projectId)).toEqual(['platform', 'app', 'mobile', 'docs', 'tools'])
    expect(Object.fromEntries(tree.parentOf)).toEqual({ app: 'platform', mobile: 'app' })
  })

  it('moves a project under another, but never into itself or its own subprojects', () => {
    expect(resolveProjectDrop(tree, 'app', { kind: 'under', projectId: 'docs' }))
      .toEqual({ move: { projectId: 'app', parentProjectId: 'docs' } })
    expect(resolveProjectDrop(tree, 'platform', { kind: 'under', projectId: 'mobile' })).toEqual({ refusal: 'cycle' })
    expect(resolveProjectDrop(tree, 'app', { kind: 'under', projectId: 'app' })).toEqual({ refusal: 'self' })
    expect(resolveProjectDrop(tree, 'app', { kind: 'under', projectId: 'platform' })).toEqual({ refusal: 'unchanged' })
  })

  it('moves a project level with its parent, or out to the top level', () => {
    expect(resolveProjectDrop(tree, 'mobile', { kind: 'sibling' }))
      .toEqual({ move: { projectId: 'mobile', parentProjectId: 'platform' } })
    expect(resolveProjectDrop(tree, 'app', { kind: 'sibling' }))
      .toEqual({ move: { projectId: 'app', parentProjectId: null } })
    expect(resolveProjectDrop(tree, 'mobile', { kind: 'top' }))
      .toEqual({ move: { projectId: 'mobile', parentProjectId: null } })
    expect(resolveProjectDrop(tree, 'docs', { kind: 'top' })).toEqual({ refusal: 'unchanged' })
    expect(resolveProjectDrop(tree, 'docs', { kind: 'sibling' })).toEqual({ refusal: 'unchanged' })
  })

  it('searches only the projects the dragged one can move under', () => {
    expect(searchMoveTargets(tree, 'app', 'synthetic').map(({ projectId }) => projectId))
      .toEqual(['docs', 'tools'])
    expect(searchMoveTargets(tree, 'mobile', 'PLAT').map(({ projectId }) => projectId)).toEqual(['platform'])
    expect(searchMoveTargets(tree, 'app', ' ')).toEqual([])
  })

  it('finds the drop panel target under the pointer', () => {
    const panel = document.createElement('div')
    panel.innerHTML = `<div data-project-drop="${dropTargetAttribute({ kind: 'top' })}"><strong>x</strong></div>`
      + `<li data-project-drop="${dropTargetAttribute({ kind: 'under', projectId: 'docs' })}"><small>y</small></li>`
    expect(dropTargetAt(panel.querySelector('strong'))).toEqual({ kind: 'top' })
    expect(dropTargetAt(panel.querySelector('small'))).toEqual({ kind: 'under', projectId: 'docs' })
    expect(dropTargetAt(panel)).toBeNull()
    expect(dropTargetAt(null)).toBeNull()
  })
})
