import { describe, expect, it } from 'vitest'

import { isManagementKnowledgeItem, knowledgeItemFromEdge, knowledgeItems, managementKnowledgeItems } from '@/features/knowledge/model'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

import { agreesWithGuess, buildReviewList, oneLine, reviewTotal, rowChoices, type DelegatedReview } from './review-list'

// Synthetic items only: no real FULI data.
const proposed = { existence_reason: 'Synthetic.', quadrant_reason: 'Synthetic.', proposed_by: { kind: 'agent', label: 'Synthetic Agent' } }
function node(id: string, overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return { id, name: `Synthetic ${id}`, type: 'Fact', summary: `Synthetic statement ${id}`, confirmation_status: 'pending',
    confirmation_state_explicit: true, confirmation_basis: proposed, preference_project_id: 'project-a', ...overrides } as KnowledgeNode
}
const graph = (...nodes: KnowledgeNode[]): KnowledgeGraph => ({ nodes, edges: [] } as unknown as KnowledgeGraph)
const review = (target: string, overrides: Partial<DelegatedReview> = {}): DelegatedReview => ({
  id: `decision-${target}`, createdAt: '2026-11-06T00:00:00Z', personalProjectId: 'project-a', target, title: null,
  summary: 'Synthetic reason', confidence: 0.6, guess: 'keep', question: 'I think you keep this. Right?', feedbackRevision: 0, ...overrides,
})
const tonborgBasis = { ...proposed, confirmed_by: { kind: 'agent', label: 'Tonborg' }, confirmed_at: '2026-11-06T00:00:00Z',
  agent_policy_version: 'tonborg-review-v1' }

describe('the 待决策 list', () => {
  it('lists what waits for the person: Tonborg\'s questions apart, nothing confirmed or historical', () => {
    const items = knowledgeItems(graph(
      node('one'), node('asked'),
      node('mine', { confirmation_status: 'confirmed', confirmation_basis: { ...proposed, confirmed_by: { kind: 'user' }, confirmed_at: '2026-11-01T00:00:00Z' } }),
      node('gone', { invalid_at: '2026-11-02T00:00:00Z' }),
    ))
    const list = buildReviewList(items, { confirmed: [], questions: [review('entity:asked')] })
    expect(list.questions.map(line => line.key)).toEqual(['entity:asked'])
    expect(list.pending.map(line => line.key)).toEqual(['entity:one'])
    expect(reviewTotal(list)).toBe(2)
    expect(list.pending[0]).toMatchObject({ projectId: 'project-a', proposer: 'Synthetic Agent', reason: 'unreviewed' })
  })

  it('puts the earlier Agent replies the server found in their own group, ahead of a Tonborg question', () => {
    const items = knowledgeItems(graph(node('one'), node('echo'), node('asked-echo'),
      node('gone-echo', { invalid_at: '2026-11-02T00:00:00Z' })))
    const list = buildReviewList(items, { confirmed: [], questions: [review('entity:asked-echo')] },
      new Set(['entity:echo', 'entity:asked-echo', 'entity:gone-echo']))
    expect(list.echoes.map(line => line.key).sort()).toEqual(['entity:asked-echo', 'entity:echo'])
    expect(list.questions).toEqual([])
    expect(list.pending.map(line => line.key)).toEqual(['entity:one'])
    expect(reviewTotal(list)).toBe(3)
  })

  it('names who proposed an item in words, never by an internal id', () => {
    const byId = { ...proposed, proposed_by: { kind: 'agent', label: 'ca14b735-2331-51c9-8565-6e192eaeefb0' } }
    const items = knowledgeItems(graph(node('one', { confirmation_basis: byId })))
    const [line] = buildReviewList(items, { confirmed: [], questions: [] }).pending
    expect(line.proposer).not.toContain('ca14b735')
    expect(line.proposer.length).toBeGreaterThan(0)
  })

  it('drops a question whose item the person already handled, and a confirmation they changed since', () => {
    const items = knowledgeItems(graph(
      node('handled', { confirmation_status: 'confirmed', confirmation_basis: { ...proposed, confirmed_by: { kind: 'user' }, confirmed_at: '2026-11-01T00:00:00Z' } }),
      node('tonborg', { confirmation_status: 'agent_confirmed', confirmation_basis: tonborgBasis }),
    ))
    const list = buildReviewList(items, { questions: [review('entity:handled')],
      confirmed: [review('entity:tonborg', { question: null }), review('entity:handled', { question: null })] })
    expect(list.questions).toEqual([])
    expect(list.confirmed.map(line => line.key)).toEqual(['entity:tonborg'])
  })

  it('says why an item waits in a fixed word, and keeps every line within 100 characters', () => {
    const items = knowledgeItems(graph(node('conflicted', { conflicts: [{ id: 'c' }] }), node('long', { summary: 'x'.repeat(300) })))
    const list = buildReviewList(items)
    expect(list.pending.find(line => line.key === 'entity:conflicted')?.reason).toBe('conflict')
    expect(list.pending.every(line => line.text.length <= 100)).toBe(true)
    expect(oneLine('a  b\n c')).toBe('a b c')
  })

  it('reads the person\'s answer as a vote on Tonborg\'s guess', () => {
    expect(agreesWithGuess(review('entity:x', { guess: 'drop' }), 'drop')).toBe(true)
    expect(agreesWithGuess(review('entity:x', { guess: 'drop' }), 'confirm')).toBe(false)
    expect(agreesWithGuess(null, 'confirm')).toBe(false)
  })

  it('never asks the person about projects the system put in the space, conversation projects included', () => {
    // Synthetic Provider output for a space with 3 temporary conversation projects and
    // one named project: the management projection draws each project and its
    // contains-project edge; memory use between projects is an observation edge.
    const space = node('space:personal', { name: 'Personal', type: 'PersonalSpace' })
    const projects = ['conv-1', 'conv-2', 'conv-3', 'named'].map(id => node(`personal-project:${id}`, {
      name: id === 'named' ? 'Synthetic Project' : '会话项目', type: 'PersonalProject' }))
    const structure = projects.map(project => ({ id: `contains-project:${project.id.split(':')[1]}`, source: space.id, target: project.id,
      type: 'CONTAINS_PROJECT', fact: `个人项目“${project.name}”保存在该个人空间中。` }) as KnowledgeEdge)
    const usage = { id: 'project-memory-usage:obs-1', source: projects[0].id, target: projects[3].id, type: 'PROJECT_MEMORY_ACCESS',
      fact: '会话项目 → Synthetic Project: 3', attributes: { totalCount: 3 } } as KnowledgeEdge
    const learned = node('learned')
    const projectGraph = { nodes: [space, ...projects, learned], edges: [...structure, usage] } as unknown as KnowledgeGraph

    const list = buildReviewList(knowledgeItems(projectGraph))
    expect(list.pending.map(line => line.key)).toEqual(['entity:learned'])
    expect(reviewTotal(list)).toBe(1)
    // Not project material either, and read-only if the graph canvas opens one.
    expect(managementKnowledgeItems(projectGraph).filter(item => item.itemKind === 'relationship')).toEqual([])
    expect(isManagementKnowledgeItem(knowledgeItemFromEdge(structure[0], new Map()))).toBe(true)
  })
})

describe('rowChoices', () => {
  const asked = (guess: DelegatedReview['guess'], answers?: DelegatedReview['answers']) => rowChoices({ guess, answers } as DelegatedReview)
  const words = (row: ReturnType<typeof rowChoices>) => [...row.choices.map(choice => `${choice.label}:${choice.action}${choice.guessed ? '*' : ''}`), `rest ${row.rest.answer}`]

  it('offers the guess first and its opposite second, and keeps the third way to answer for 其他', () => {
    expect(words(asked('keep', ['keep', 'drop']))).toEqual(['keep:confirm*', 'drop:drop', 'rest edit'])
    expect(words(asked('drop', ['drop', 'keep']))).toEqual(['drop:drop*', 'keep:confirm', 'rest edit'])
    // The opposite of 改一下 is keeping it as it is; dropping it sits under 其他.
    expect(words(asked('edit', ['edit', 'keep']))).toEqual(['edit:edit*', 'keepAsIs:confirm', 'rest drop'])
  })

  it('asks keep or drop with neither marked when the review has no guess or choices', () => {
    expect(words(asked(null))).toEqual(['keep:confirm', 'drop:drop', 'rest edit'])
  })
})
