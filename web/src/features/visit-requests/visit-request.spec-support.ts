import { vi } from 'vitest'
import type { VisitRequest, VisitRequestCard } from './visit-request-shape'

// Synthetic visit requests for the specs: one made-up computer and assistant, never real data.
export const PEER_KEY = `peer:${'c'.repeat(64)}`
export const GUEST_KEY = 'guest:synthetic-link'

export function visitRequest(fields: Partial<VisitRequest> = {}): VisitRequest {
  return {
    id: 'visit-1', state: 'awaiting_owner', review: null, holdReason: null,
    requester: { key: PEER_KEY, label: 'Synthetic laptop', agentName: 'Sample lead', source: 'peer' },
    projectId: 'sample-project', agentId: 'sample-lead', title: 'Fix the sample typo',
    plan: { areas: ['src/sample.js'], risks: [], dependencyChanges: false, configChanges: false, network: false, size: 's' },
    planError: null, risk: { level: 'low', flags: [] }, modeAtReceipt: 'plan', modeAtDecision: null, decidedBy: null,
    reason: null, error: null, result: null, createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T08:00:00.000Z',
    ...fields,
  }
}

export function visitCard(fields: Partial<VisitRequestCard> = {}): VisitRequestCard {
  return {
    ...visitRequest(), what: 'Please fix the typo in the sample file.', requesterAreas: ['src/sample.js'],
    events: [{ from: null, to: 'received', by: 'requester', rule: null, checks: null, note: null, at: '2026-11-14T08:00:00.000Z' },
      { from: 'received', to: 'planning', by: 'system', rule: null, checks: null, note: null, at: '2026-11-14T08:00:01.000Z' },
      { from: 'planning', to: 'awaiting_owner', by: 'system', rule: null, checks: null, note: null, at: '2026-11-14T08:01:00.000Z' }],
    diff: null,
    ...fields,
  }
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fetch that answers each route (method and path, without the query) from
 * `routes`; an unknown route answers 404. Every call is kept.
 */
export function stubServer(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    return key in routes ? json(routes[key]) : json({ error: 'not_found' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  const calls = (key: string) => fetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${url.split('?')[0]}` === key)
  return { fetch, calls }
}
