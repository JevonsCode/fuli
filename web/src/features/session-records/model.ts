import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'

// rec#5 C6 "本会话记了什么": one host session's records as the host numbered
// them, so this page and the Agent's answer list the same items. Payload
// types and the labels built from them; the page only composes.

export type SessionGroup = 'transcript' | 'knowledge' | 'preference_evidence'
export const SESSION_GROUPS: readonly SessionGroup[] = ['transcript', 'knowledge', 'preference_evidence']

export interface SessionProject { id: string; name?: string | null; temporary?: boolean }

export interface TurnMessage { role: 'user' | 'assistant'; text: string; created_at?: string | null }

export interface SessionItem extends KnowledgeItemSummary {
  change: 'created' | 'updated' | 'evidence'
  episode_id: string
  excerpt?: string | null
}

export interface SessionEntry {
  number: number
  group: SessionGroup
  /** turn:<task>, entity:<id> or relationship:<id>: the Peek identity. */
  key: string
  kind: 'turn' | 'entity' | 'relationship'
  type: string
  summary: string
  status?: KnowledgeItemSummary['confirmation_status']
  at?: string | null
  project: SessionProject | null
  /** The turn an item was written in, when the session saved it. */
  turn?: string | null
  link: string
  detail: { messages?: TurnMessage[]; items?: string[]; item?: SessionItem; episode_id?: string }
}

export interface NotRecordedStretch { from: string; to: string; paused: boolean; reasons: string[] }

export interface SessionRecordsView {
  session: { sourceApplication: string; sessionId: string; url: string }
  total: number
  entries: SessionEntry[]
  stretches: NotRecordedStretch[]
  truncated: boolean
}

/** The console path of one session's list; with a key, that record's quick look. */
export function sessionRecordsPath(spaceId: string, sourceApplication: string, sessionId: string, key = '') {
  const path = `/sessions/${encodeURIComponent(spaceId)}/${encodeURIComponent(sourceApplication)}/${encodeURIComponent(sessionId)}`
  return key ? `${path}?item=${encodeURIComponent(spaceId)}/${encodeURIComponent(key)}` : path
}

/** A knowledge source's way back to the turn that wrote it (G1-4 / C6-3). */
export function sourceSessionPath(spaceId: string, source: { session_id?: string | null;
  source_application?: string | null; episode_id: string }) {
  if (!source.session_id || !source.source_application) return ''
  return sessionRecordsPath(spaceId, source.source_application, source.session_id, `episode:${source.episode_id}`)
}

/**
 * The entry a quick-look key names. episode:<id> (a knowledge source's link)
 * opens the turn that wrote that episode, or the item itself when the turn's
 * words were not saved.
 */
export function peekEntry(view: SessionRecordsView | null, key: string) {
  if (!view || !key) return null
  if (!key.startsWith('episode:')) return view.entries.find(entry => entry.key === key) ?? null
  const episode = key.slice('episode:'.length)
  const item = view.entries.find(entry => entry.detail.episode_id === episode)
  return (item?.turn && view.entries.find(entry => entry.key === item.turn)) || item || null
}

export function groupEntries(view: SessionRecordsView, group: SessionGroup) {
  return view.entries.filter(entry => entry.group === group)
}

export type TranscriptRow = { kind: 'entry'; entry: SessionEntry } | { kind: 'stretch'; stretch: NotRecordedStretch }

/** Saved turns and not-recorded stretches in time order. */
export function transcriptRows(view: SessionRecordsView): TranscriptRow[] {
  const rows: TranscriptRow[] = [
    ...groupEntries(view, 'transcript').map(entry => ({ kind: 'entry' as const, entry })),
    ...view.stretches.map(stretch => ({ kind: 'stretch' as const, stretch })),
  ]
  const time = (row: TranscriptRow) => new Date((row.kind === 'entry' ? row.entry.at : row.stretch.from) ?? 0).getTime()
  return rows.sort((left, right) => time(left) - time(right))
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
const DAY_CLOCK: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric', ...CLOCK }

export function clockTime(value?: string | null) {
  return formatDateTime(value, currentLocale(), CLOCK, { missing: '--:--' })
}

export function recordedAt(value?: string | null) {
  return formatDateTime(value, currentLocale(), DAY_CLOCK, { missing: t('sessionRecords.noTime') })
}

/** "14:32～15:10 暂停记录": a stretch that holds no record. */
export function stretchLabel(stretch: NotRecordedStretch) {
  return t(stretch.paused ? 'sessionRecords.stretch.paused' : 'sessionRecords.stretch.notRecorded',
    { from: clockTime(stretch.from), to: clockTime(stretch.to) })
}

export function projectLabel(project: SessionProject | null) {
  if (!project) return t('sessionRecords.noProject')
  return project.temporary ? t('knowledgeQuickEdit.scope.temporary') : project.name || project.id
}

/** The entry's type in the page's language; the Agent's answer says the same in Chinese. */
export function entryTypeLabel(entry: SessionEntry) {
  if (entry.group === 'transcript') return t('sessionRecords.type.turn')
  if (entry.group === 'preference_evidence') return t('sessionRecords.type.evidence')
  const item = entry.detail.item
  const change = t(`sessionRecords.type.${item?.change === 'updated' ? 'updated' : 'created'}`)
  return item ? `${change} ${t(`knowledgeQuickEdit.category.${item.category}`)}` : entry.type
}
