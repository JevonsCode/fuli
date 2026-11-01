import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const readProjectTeam = vi.hoisted(() => vi.fn())
const summaries = vi.hoisted(() => ({ value: {} as Record<string, { status: string }> }))
vi.mock('@/features/projects/project-team-api', () => ({ readProjectTeam }))
vi.mock('@/features/agent-profile/useAgentWorkSummary', () => ({
  useAgentWorkSummary: () => ({ summaries: ref(summaries.value), load: vi.fn() }),
}))

import { setLocale } from '@/i18n'
import type { KnowledgeGraph, KnowledgeNode, PersonalProject } from '@/types'
import ProjectPeek from './ProjectPeek.vue'
import { knowledgeItemFromNode } from './model'
import { projectFamily } from './project-family'

// Synthetic projects only: a parent with two children, one of which is open.
const project = (id: string): KnowledgeNode => ({ id: `node-${id}`, name: id, type: 'PersonalProject', attributes: { projectId: id } })
const graph: KnowledgeGraph = {
  nodes: [project('parent'), project('open'), project('sibling'), project('child')],
  edges: [
    { id: 'e1', source: 'node-open', target: 'node-parent', type: 'PART_OF' },
    { id: 'e2', source: 'node-sibling', target: 'node-parent', type: 'PART_OF' },
    { id: 'e3', source: 'node-child', target: 'node-open', type: 'PART_OF' },
  ],
}
const record: PersonalProject = {
  project_id: 'open', personal_space_id: 'space-a', publication_key: 'synthetic-publication-key',
  profile: { name: 'open', purpose: 'A synthetic project for the quick look.' },
  created_at: '2026-10-01T08:00:00.000Z', updated_at: '2026-10-30T08:00:00.000Z',
}
const person = (agentId: string, name: string) => ({ agentId, name, employeeNumber: null, occupationEmoji: null, responsibility: 'Synthetic work', peerRole: false })

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  readProjectTeam.mockReset()
  summaries.value = {}
})

describe('projectFamily', () => {
  it('names the parent, the siblings under it and the children', () => {
    const family = projectFamily(graph, project('open'))
    expect(family.parents.map(item => item.projectId)).toEqual(['parent'])
    expect(family.siblings.map(item => item.projectId)).toEqual(['sibling'])
    expect(family.children.map(item => item.projectId)).toEqual(['child'])
    expect(projectFamily(null, project('open'))).toEqual({ parents: [], siblings: [], children: [] })
  })
})

describe('ProjectPeek', () => {
  const mountPeek = () => mount(ProjectPeek, { props: {
    item: knowledgeItemFromNode(project('open')), graph, project: record, spaceId: 'space-a',
  } })

  it('leads with the description and the team, marks who is working, and keeps IDs in a corner', async () => {
    readProjectTeam.mockResolvedValue({ personalProjectId: 'open', status: 'ready', lead: person('lead-a', 'Lead A'),
      unavailableLead: null, members: [person('member-b', 'Member B')], collaborators: [], peers: [], unavailableMemberIds: [] })
    summaries.value = { 'member-b': { status: 'running' } }
    const wrapper = mountPeek()
    await flushPromises()
    expect(wrapper.get('[data-project-description]').text()).toBe('A synthetic project for the quick look.')
    const people = wrapper.findAll('[data-project-person]')
    expect(people.map(row => row.find('strong').text())).toEqual(['Lead A', 'Member B'])
    expect(people[0].text()).toContain('组长')
    expect(people[1].find('[data-project-working]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('synthetic-publication-key')
    await wrapper.get('[data-project-ids-toggle]').trigger('click')
    expect(wrapper.get('[data-project-ids]').text()).toContain('open')
  })

  it('opens the project with one action and shows the related projects only on request', async () => {
    readProjectTeam.mockRejectedValue(new Error('synthetic failure'))
    const wrapper = mountPeek()
    await flushPromises()
    expect(wrapper.text()).toContain('还没有 FLA 负责这个项目')
    expect(wrapper.find('[data-project-family]').exists()).toBe(false)
    await wrapper.get('[data-project-family-toggle]').trigger('click')
    expect(wrapper.get('[data-project-family]').text()).toContain('sibling')
    await wrapper.get('[data-project-open]').trigger('click')
    expect(wrapper.emitted('openProject')).toEqual([['open']])
  })
})
