import { getJson } from '@/api/client'
import type { SessionRecordsView } from './model'

// The console route behind a receipt's 本会话已记录 link (rec#5 C6).
export function readSessionRecords(spaceId: string, sourceApplication: string, sessionId: string) {
  return getJson<SessionRecordsView>(`/api/session-records?${new URLSearchParams({ personalSpaceId: spaceId,
    sourceApplication, sessionId })}`)
}
