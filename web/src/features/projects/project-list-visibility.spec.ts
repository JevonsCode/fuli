import { describe, expect, it } from 'vitest'
import type { KnowledgeGraph, PersonalProject } from '@/types'
import { filterListedProjectGraph, isListedProject } from './project-list-visibility'

const project = (id: string, extra: Partial<PersonalProject> = {}): PersonalProject => ({
  project_id: id, personal_space_id: 'space', profile: { name: id }, ...extra,
})
const hidden = { showTemporary: false, selectedProjectId: null }

describe('project listing visibility', () => {
  it('uses origin and scope, never the display name, and never reveals archives', () => {
    const projects = [
      project('formal', { profile: { name: '会话项目' } }),
      project('temp', { scope_type: 'temporary' }),
      project(`conversation-${'a'.repeat(64)}`),
      project('fallback', { profile: { name: 'x', origin: 'conversation_fallback' } }),
      project('archived', { status: 'archived' }),
      project('archived-profile', { profile: { name: 'x', lifecycle: 'archived' } }),
    ]
    expect(projects.filter(p => isListedProject(p, hidden)).map(p => p.project_id)).toEqual(['formal'])
    expect(projects.filter(p => isListedProject(p, { ...hidden, showTemporary: true }))).toHaveLength(4)
    expect(isListedProject(projects[1]!, { ...hidden, selectedProjectId: 'temp' })).toBe(true)
    expect(isListedProject(projects[4]!, { ...hidden, selectedProjectId: 'archived' })).toBe(false)
  })

  it('removes hidden project profiles and dangling edges while preserving the source and ordinary knowledge', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        { id: 'personal-project:15b0624e-0625-56ac-b8f7-6db8219798a1', name: 'Temp', type: 'PersonalProject', attributes: { projectId: 'temp' } },
        { id: 'project-profile:15b0624e-0625-56ac-b8f7-6db8219798a1:purpose', name: 'Purpose', type: 'ProjectPurpose' },
        { id: 'project-profile:15b0624e-0625-56ac-b8f7-6db8219798a1:assessment:scope', name: 'Scope', type: 'AssessmentDimension' },
        { id: 'knowledge', name: 'Shared knowledge', type: 'Decision' },
        { id: 'archive-root', name: 'Old', type: 'RelatedPersonalProject', attributes: { projectId: 'old', lifecycle: 'archived' } },
      ],
      edges: [{ id: 'edge', source: 'personal-project:15b0624e-0625-56ac-b8f7-6db8219798a1', target: 'project-profile:15b0624e-0625-56ac-b8f7-6db8219798a1:purpose', type: 'HAS_PURPOSE' }],
    }
    const projects = [project('temp', { scope_type: 'temporary' })]
    expect(filterListedProjectGraph(graph, projects, hidden).nodes.map(n => n.id)).toEqual(['knowledge'])
    expect(filterListedProjectGraph(graph, projects, hidden).edges).toEqual([])
    const shown = filterListedProjectGraph(graph, projects, { ...hidden, showTemporary: true })
    expect(shown.nodes.map(n => n.id)).toEqual(['personal-project:15b0624e-0625-56ac-b8f7-6db8219798a1', 'project-profile:15b0624e-0625-56ac-b8f7-6db8219798a1:purpose', 'project-profile:15b0624e-0625-56ac-b8f7-6db8219798a1:assessment:scope', 'knowledge'])
    expect(shown.edges).toHaveLength(1)
    expect(graph.nodes).toHaveLength(5)
    expect(graph.edges).toHaveLength(1)
  })
})
