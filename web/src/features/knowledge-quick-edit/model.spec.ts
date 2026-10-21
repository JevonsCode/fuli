import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import {
  contentRequest, deactivateRequest, editFailure, initialScopeDraft, itemEditPath, scopeChoices, scopeLabel,
  scopeRequest, tagProjectId, weightBasisLabel, type KnowledgeItemSummary,
} from './model'

// rec#20 quick edit: the labels and requests a receipt link's page builds.
function item(overrides: Partial<KnowledgeItemSummary> = {}): KnowledgeItemSummary {
  return { item_kind: 'entity', item_id: 'item-1', version: 4, title: 'Lead with the conclusion',
    content: 'Lead with the conclusion', type: 'PersonalPreference', profile_aspect: 'taste', category: 'taste',
    scope: { kind: 'global', projects: [], status: 'set' }, tags: [], confirmation_status: 'pending',
    content_source: 'agent_inferred', weight: { percent: 12, basis: { confirmation_status: 'pending',
      confirmed_by_person: false, qualified_use_count: 2, distinct_task_count: 1, source_count: 1, negative_evidence_count: 0 } },
    ...overrides }
}

describe('knowledge quick edit model', () => {
  it('links to the item itself, never the knowledge home', () => {
    expect(itemEditPath('space one', { item_kind: 'relationship', item_id: 'a/b' }))
      .toBe('/knowledge/item/space%20one/relationship/a%2Fb')
  })

  it('names where an item applies, keeping an undecided scope a separate mark', () => {
    expect(scopeLabel({ kind: 'global', projects: [], status: 'set' })).toBe('个人全局')
    expect(scopeLabel({ kind: 'projects', projects: [{ id: 'a', name: 'Alpha' }, { id: 'b' }], status: 'set' }))
      .toBe('项目：Alpha、b')
    expect(scopeLabel({ kind: 'agent', projects: [{ id: 'a', name: 'Alpha' }], agent_id: 'r', agent_name: 'Nova', status: 'set' }))
      .toBe('FLA Nova（Alpha）')
    expect(scopeLabel({ kind: 'temporary', projects: [{ id: 'temporary-x', temporary: true }], status: 'undetermined' }))
      .toBe('临时会话项目')
  })

  it('shows what the weight rests on and says it is computed', () => {
    expect(weightBasisLabel(item().weight!)).toBe('依据：用过 2 次 · 1 个任务 · 1 个来源')
    expect(weightBasisLabel({ percent: 100, basis: { ...item().weight!.basis, confirmed_by_person: true } }))
      .toBe('你确认过，按 100% 使用。')
  })

  it('builds scope changes with the version the page read', () => {
    const preference = item()
    expect(scopeChoices(preference)).toEqual(['global', 'projects', 'agent'])
    expect(scopeRequest('s', preference, { choice: 'projects', projectIds: ['a', 'b'], agentProjectId: '', agentId: '' }, ' why '))
      .toEqual({ personalSpaceId: 's', expectedVersion: 4, reason: 'why', scope: 'projects', projectIds: ['a', 'b'] })
    expect(scopeRequest('s', preference, { choice: 'agent', projectIds: [], agentProjectId: 'a', agentId: 'r' }, 'why'))
      .toMatchObject({ scope: 'agent', projectIds: ['a'], agentId: 'r' })
    expect(scopeRequest('s', preference, { choice: 'agent', projectIds: [], agentProjectId: 'a', agentId: '' }, 'why')).toBeNull()
    expect(scopeRequest('s', preference, { choice: 'global', projectIds: [], agentProjectId: '', agentId: '' }, ' ')).toBeNull()
    const fact = item({ profile_aspect: null, category: 'fact' })
    expect(scopeChoices(fact)).toEqual(['projects'])
    expect(scopeRequest('s', fact, { choice: 'projects', projectIds: ['a', 'b'], agentProjectId: '', agentId: '' }, 'why'))
      .toMatchObject({ projectIds: ['a'] })
  })

  it('starts an undecided item from a project choice, never from global', () => {
    const held = item({ scope: { kind: 'temporary', projects: [{ id: 'temporary-x', temporary: true }], status: 'undetermined' } })
    expect(initialScopeDraft(held)).toEqual({ choice: 'projects', projectIds: [], agentProjectId: '', agentId: '' })
  })

  it('builds content edits and deactivation for the same item and version', () => {
    expect(contentRequest('s', item(), ' Lead with the answer ', 'clearer')).toEqual({ personalSpaceId: 's', action: 'update',
      reason: 'clearer', expectedVersion: 4, name: 'Lead with the answer', summary: 'Lead with the answer' })
    expect(contentRequest('s', item({ item_kind: 'relationship' }), 'fact', 'why')).toMatchObject({ fact: 'fact' })
    expect(contentRequest('s', item(), 'x', ' ')).toBeNull()
    expect(deactivateRequest('s', item(), 'no longer true')).toEqual({ personalSpaceId: 's', action: 'invalidate',
      reason: 'no longer true', expectedVersion: 4 })
  })

  it('tags a project item from one of its projects and global knowledge from none', () => {
    expect(tagProjectId(item())).toBeNull()
    expect(tagProjectId(item({ scope: { kind: 'projects', projects: [{ id: 'a' }], status: 'set' } }))).toBe('a')
  })

  it('changes a project tag from its own project, even on a second project of the item', () => {
    const twoProjects = item({ scope: { kind: 'projects', projects: [{ id: 'a' }, { id: 'b' }], status: 'set' } })
    expect(tagProjectId(twoProjects, { namespace: 'project', project_id: 'b' })).toBe('b')
    expect(tagProjectId(twoProjects, { namespace: 'personal', project_id: null })).toBe('a')
  })

  it('tells a stale page, a widening and a refusal apart', () => {
    expect(editFailure(new ApiError('x', 409, JSON.stringify({ error: 'x', code: 'stale_version' })))).toBe('conflict')
    expect(editFailure(new ApiError('x', 409, JSON.stringify({ error: 'x', code: 'widening_requires_review' })))).toBe('widening')
    expect(editFailure(new ApiError('x', 403))).toBe('forbidden')
    expect(editFailure(new Error('network'))).toBe('other')
  })
})
