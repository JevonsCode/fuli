import { describe, expect, it } from 'vitest'

import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import type { SessionEntry, SessionRecordsView } from '@/features/session-records/model'
import { defaultReason, migrationPath, migrationRequest, reconcileChoice, sessionMigrationOffers, type SessionMigrationPreview } from './model'

// rec#20 part 2: the requests and choices of a session's batch migration.
function item(id: string, version = 0, overrides: Partial<KnowledgeItemSummary> = {}): KnowledgeItemSummary {
  return { item_kind: 'entity', item_id: id, version, title: id, content: `Synthetic ${id}`, type: 'ProjectFact',
    category: 'fact', scope: { kind: 'temporary', projects: [{ id: 'temporary-x', temporary: true }], status: 'undetermined' },
    tags: [], confirmation_status: 'pending', content_source: 'agent_inferred', ...overrides }
}

function preview(items: KnowledgeItemSummary[]): SessionMigrationPreview {
  return { temporary_project_id: 'temporary-x', target_project: { id: 'alpha', name: 'Alpha' }, held_count: items.length,
    linked_task_count: 1, truncated: false, items }
}

const target = { spaceId: 'space', sessionId: 'session-1', client: 'codex', projectId: 'alpha' }

describe('session migration model', () => {
  it('sends exactly the chosen items with the versions the page showed', () => {
    const shown = preview([item('a', 2), item('b', 0, { item_kind: 'relationship' }), item('c')])
    expect(migrationRequest(target, shown, new Set(['entity:a', 'relationship:b']), ' This session is Alpha ')).toEqual({
      personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'session-1', projectId: 'alpha',
      reason: 'This session is Alpha', items: [{ itemKind: 'entity', itemId: 'a', expectedVersion: 2 },
        { itemKind: 'relationship', itemId: 'b', expectedVersion: 0 }] })
    expect(migrationRequest(target, shown, new Set(), 'why')).toBeNull()
    expect(migrationRequest(target, shown, new Set(['entity:a']), ' ')).toBeNull()
    expect(defaultReason(shown)).toBe('这个会话属于「Alpha」')
  })

  it('starts with every item chosen and keeps the person\'s choice across a re-read', () => {
    const first = preview([item('a'), item('b'), item('c')])
    expect([...reconcileChoice(null, first, new Set()).chosen]).toEqual(['entity:a', 'entity:b', 'entity:c'])
    // b was left out, a changed meanwhile, c was placed elsewhere, d is newly held.
    const next = reconcileChoice(first, preview([item('a', 1), item('b'), item('d')]), new Set(['entity:a', 'entity:c']))
    expect([...next.chosen]).toEqual(['entity:a', 'entity:d'])
    expect([...next.changed]).toEqual(['entity:a'])
    expect(next.gone).toBe(1)
  })

  it('offers each formal project the session worked in while it still holds undecided items', () => {
    const entry = (overrides: Partial<SessionEntry>): SessionEntry => ({ number: 1, group: 'transcript', key: 'turn:1',
      kind: 'turn', type: 'turn', summary: 's', project: null, link: '', detail: {}, ...overrides })
    const view = (entries: SessionEntry[]): SessionRecordsView => ({ session: { sourceApplication: 'codex', sessionId: 'session-1',
      url: '' }, total: entries.length, entries, stretches: [], truncated: false })
    const held = entry({ group: 'knowledge', key: 'entity:a', kind: 'entity', detail: { item: { ...item('a'), change: 'created',
      episode_id: 'e1' } } })
    const turns = [entry({ key: 'turn:1', project: { id: 'temporary-x', temporary: true } }),
      entry({ key: 'turn:2', project: { id: 'alpha', name: 'Alpha' } }), entry({ key: 'turn:3', project: { id: 'beta', name: 'Beta' } })]
    expect(sessionMigrationOffers(view([...turns, held])).map(offer => [offer.project.id, offer.path])).toEqual([
      ['beta', migrationPath('session-1', 'codex', 'beta')], ['alpha', '/s/session-1/migrate?client=codex&project=alpha']])
    expect(sessionMigrationOffers(view(turns))).toEqual([])
    expect(sessionMigrationOffers(view([turns[0], held]))).toEqual([])
    expect(sessionMigrationOffers(null)).toEqual([])
  })
})
