import { describe, expect, it } from 'vitest'

import { knowledgeItems } from '@/features/knowledge/model'
import type { KnowledgeGraph, KnowledgeNode } from '@/types'

import { agreesWithGuess, buildReviewList, oneLine, reviewTotal, type DelegatedReview } from './review-list'

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
})
