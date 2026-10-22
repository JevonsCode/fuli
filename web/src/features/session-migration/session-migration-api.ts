import { getJson, postJson } from '@/api/client'
import type { MigrationTarget, SessionMigrationPreview, SessionMigrationResult } from './model'

// The console routes of a session's batch migration (rec#20 part 2). The read
// is one page of the held items. The post is accepted only from this computer
// and leaves on the human-review channel; the Provider moves each item through
// the quick edit's scope change.
export function readSessionMigration(target: MigrationTarget, offset = 0) {
  return getJson<SessionMigrationPreview>(`/api/knowledge/session-migration?${new URLSearchParams({
    personalSpaceId: target.spaceId, sessionId: target.sessionId, client: target.client, projectId: target.projectId,
    offset: String(offset) })}`)
}

export function applySessionMigration(body: object) {
  return postJson<SessionMigrationResult>('/api/knowledge/session-migration', body)
}
