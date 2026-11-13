import { getJson, postJson, putJson } from '@/api/client'
import { requesterModeShape, requestersShape, visitCardShape, visitDecisionShape, visitListShape, type RequesterMode, type VisitState } from './visit-request-shape'

// The console's calls for work another computer asked for, all on this computer's loopback.

export type VisitAction = 'approve' | 'decline' | 'cancel' | 'keep' | 'discard'

export function readVisitRequests({ state = null, limit }: { state?: VisitState | null; limit: number }) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (state) query.set('state', state)
  return getJson(`/api/visit-requests?${query}`, visitListShape)
}

export async function readVisitRequest(id: string) {
  return (await getJson(`/api/visit-requests/${encodeURIComponent(id)}`, visitCardShape)).request
}

/** `reason` is read only by decline. */
export async function decideVisitRequest(id: string, action: VisitAction, reason?: string) {
  const body = action === 'decline' && reason?.trim() ? { reason: reason.trim() } : {}
  return (await postJson(`/api/visit-requests/${encodeURIComponent(id)}/${action}`, body, visitDecisionShape)).request
}

export function readRequesters() {
  return getJson('/api/visitor-access/requesters', requestersShape)
}

/** `label`: how the console names the computer, stored for a requester seen here for the first time. */
export function saveRequesterMode(key: string, mode: RequesterMode, label: string) {
  return putJson(`/api/visitor-access/requesters/${encodeURIComponent(key)}/mode`, { mode, label }, requesterModeShape)
}
