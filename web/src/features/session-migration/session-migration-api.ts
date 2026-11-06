import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import {
  migrationDeliveryReadSchema, sessionMigrationResultSchema, type MigrationTarget, type SessionMigrationPreview,
} from './model'

// The console routes of a session's batch migration (rec#20 part 2). The read
// is one page of the held items. The post is accepted only from this computer
// and leaves on the human-review channel; the Provider moves each item through
// the quick edit's scope change. Its migrationId makes a repeat answer the
// recorded move instead of sending it again (rec#82).
export function readSessionMigration(target: MigrationTarget, offset = 0) {
  return getJson<SessionMigrationPreview>(`/api/knowledge/session-migration?${new URLSearchParams({
    personalSpaceId: target.spaceId, sessionId: target.sessionId, client: target.client, projectId: target.projectId,
    offset: String(offset) })}`)
}

export function applySessionMigration(body: object) {
  return postJson('/api/knowledge/session-migration', body, shapeOf(sessionMigrationResultSchema))
}

// rec#82: whether the chat whose items a confirmed migration moved has been told yet.
export function readMigrationDelivery(target: MigrationTarget, migrationId: string) {
  return getJson(`/api/knowledge/session-migration/delivery?${new URLSearchParams({
    personalSpaceId: target.spaceId, sessionId: target.sessionId, client: target.client, projectId: target.projectId,
    migrationId })}`, shapeOf(migrationDeliveryReadSchema))
}
