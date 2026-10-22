import { getJson, postJson } from '@/api/client'
import type { MigrationTarget, SessionMigrationPreview, SessionMigrationResult } from './model'

// The console routes of a session's batch migration (rec#20 part 2). The post
// is accepted only from this computer; the Provider moves each item through the
// quick edit's scope change.
export function readSessionMigration(target: MigrationTarget) {
  return getJson<SessionMigrationPreview>(`/api/knowledge/session-migration?${new URLSearchParams({
    personalSpaceId: target.spaceId, sessionId: target.sessionId, client: target.client, projectId: target.projectId })}`)
}

export function applySessionMigration(body: object) {
  return postJson<SessionMigrationResult>('/api/knowledge/session-migration', body)
}
