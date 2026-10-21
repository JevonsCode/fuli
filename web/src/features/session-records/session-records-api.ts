import { getJson } from '@/api/client'
import type { SessionRecordsView } from './model'

// The console route behind a receipt's 本会话已记录 link (rec#5 C6).
// client may be empty: the host finds the session's one client.
export function readSessionRecords(spaceId: string, sessionId: string, client = '') {
  return getJson<SessionRecordsView>(`/api/session-records?${new URLSearchParams({ personalSpaceId: spaceId,
    sessionId, ...(client ? { sourceApplication: client } : {}) })}`)
}
