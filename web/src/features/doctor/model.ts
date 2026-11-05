import { getJson, postJson } from '@/api/client'
import { sourceApplicationName } from '@/features/knowledge/source-adapters'
import { currentLocale, t } from '@/i18n'
import { tableLabel } from '@/i18n/label-table'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import type { ConversationSourceApplication } from '@/types'

// FULI's 体检 (src/system/doctor.js): whether it works and what needs fixing.
// The banner shows the items that need someone (warning and blocking ones);
// info items, such as a newer version, are shown where they belong.

export type DoctorOverall = 'ok' | 'needs_person' | 'degraded'
export type DoctorSeverity = 'info' | 'warning' | 'blocking'

export interface DoctorItem {
  id: string
  kind: string
  severity: DoctorSeverity
  fix: 'auto' | 'person'
  data: Record<string, unknown>
}

export interface DoctorReport {
  checkedAt: string
  version: string
  overall: DoctorOverall
  items: DoctorItem[]
  unchecked: string[]
}

export interface DoctorRepairResult {
  id: string
  outcome: 'fixed' | 'failed' | 'skipped'
  error?: string
}

export const readDoctor = () => getJson<DoctorReport>('/api/system/doctor')
export const repairDoctor = () => postJson<{ results: DoctorRepairResult[]; doctor: DoctorReport }>('/api/system/doctor/repair', {})

// What needs someone: every item but info, most severe first as the doctor sends them.
export const attentionItems = (report: DoctorReport | null) => report?.items.filter(item => item.severity !== 'info') ?? []

export const canRepair = (items: DoctorItem[]) => items.some(item => item.fix === 'auto')

// What the repair is doing: reconnecting clients, limiting the data folder (Windows), or both.
export function repairingLabel(items: DoctorItem[]) {
  const automatic = items.filter(item => item.fix === 'auto')
  const dataDir = automatic.some(item => item.kind === 'data_dir_shared')
  if (!dataDir) return t('doctor.repairing')
  return t(automatic.every(item => item.kind === 'data_dir_shared') ? 'doctor.repairingDataDir' : 'doctor.repairingBoth')
}

export interface DoctorItemView {
  title: string
  subject: string
  hint: string
  // Since when it has been so (the doctor's data.since), formatted, or ''.
  since: string
  // Where the person handles it in the console, or null.
  to: string | null
}

const text = (value: unknown) => typeof value === 'string' ? value : ''

// A port FULI's last start moved by itself (src/system/blocked-port-recovery.js).
interface PortMove { key: string; from: number; to: number; reason: 'reserved' | 'refused' | 'in_use' }

// The sentence the shell says once when the running console's start moved
// ports: the console's own move when there is one, else the graph services'.
// The id names that start, so a later start that moves again is said again.
export function portsMovedNotice(report: DoctorReport | null): { id: string; message: string } | null {
  const moved = report?.items.find(item => item.kind === 'ports_moved')
  if (!moved) return null
  const moves = Array.isArray(moved.data.moves) ? moved.data.moves as PortMove[] : []
  const consoleMove = moves.find(move => move.key === 'console')
  const message = consoleMove
    ? t(consoleMove.reason === 'in_use' ? 'doctor.portsMoved.consoleInUse' : 'doctor.portsMoved.consoleReserved',
      { from: consoleMove.from, to: consoleMove.to })
    : t('doctor.portsMoved.services')
  return { id: moved.id, message }
}

// A session whose MCP server still runs an older FULI (sessions_outdated's sessions).
export interface OutdatedSession { sourceApplication: ConversationSourceApplication; sessionId: string }

// The characters of a session ID a label keeps: enough to tell a few open sessions apart.
const SESSION_SUFFIX = 6

export function outdatedSessions(item: DoctorItem): OutdatedSession[] {
  if (!['sessions_outdated', 'client_restart'].includes(item.kind) || !Array.isArray(item.data.sessions)) return []
  return (item.data.sessions as Partial<OutdatedSession>[]).filter((session): session is OutdatedSession =>
    Boolean(text(session?.sourceApplication) && text(session?.sessionId)))
}

export const outdatedSessionKey = (session: OutdatedSession) => `${session.sourceApplication}:${session.sessionId}`

// The client and the end of the session ID, never the whole ID.
export const outdatedSessionLabel = (session: OutdatedSession) =>
  `${sourceApplicationName(session.sourceApplication) ?? t('doctor.otherClient')} …${session.sessionId.slice(-SESSION_SUFFIX)}`

// One item in plain words: never its kind code. A kind this console does not
// know yet still reads as something to look at.
export function doctorItemView(item: DoctorItem): DoctorItemView {
  const since = sinceLabel(item.data.since)
  return { ...itemView(item), since }
}

const sinceLabel = (value: unknown) => {
  const time = text(value) ? formatDateTime(text(value), currentLocale(), DATE_TIME_MINUTE, { missing: '', invalid: '' }) : ''
  return time ? t('doctor.since', { time }) : ''
}

function itemView(item: DoctorItem): Omit<DoctorItemView, 'since'> {
  const title = tableLabel('doctor.kinds', item.kind) ?? t('doctor.kinds.other')
  const data = item.data
  switch (item.kind) {
    case 'client_outdated':
      return { title, subject: text(data.label), hint: t(item.fix === 'auto' ? 'doctor.hints.clientAuto' : 'doctor.hints.clientPerson'),
        to: item.fix === 'auto' ? null : '/settings?tab=clients' }
    // lastSeenAt: the graph's answer from before its service went idle (src/system/doctor.js).
    case 'data_format_waiting':
    case 'data_format_blocked':
      return { title, subject: text(data.label), to: '/settings/data-format', hint: text(data.lastSeenAt)
        ? t('doctor.hints.dataFormatLastSeen', { time: formatDateTime(text(data.lastSeenAt), currentLocale(), DATE_TIME_MINUTE, { missing: '' }) })
        : t('doctor.hints.dataFormat') }
    // An older install's Docker graph (src/system/graph-migration.js): moved from Settings.
    case 'graph_container':
      return { title, subject: '', to: '/settings?tab=system',
        hint: t((data.migration as { status?: string } | null)?.status === 'failed' ? 'doctor.hints.graphMigrationFailed' : 'doctor.hints.graphContainer') }
    case 'sessions_outdated':
      return { title, subject: sourceApplicationName(text(data.client) as ConversationSourceApplication) ?? t('doctor.otherClient'),
        hint: t('doctor.hints.sessions', { count: Number(data.count) || 0, version: text(data.runningVersion) }), to: null }
    case 'client_restart':
      return { title, subject: sourceApplicationName(text(data.client) as ConversationSourceApplication) ?? t('doctor.otherClient'),
        hint: t('doctor.hints.restart', { count: Number(data.count) || 0 }), to: null }
    case 'update_left_work':
      return { title, subject: '', to: null, hint: data.status === 'failed'
        ? t('doctor.hints.updateFailed', { reason: text(data.error) })
        : t('doctor.hints.updateReconnect') }
    // On Windows other accounts or sandboxes can open the data folder (src/system/windows-data-acl.js).
    case 'data_dir_shared':
      return { title, subject: '', hint: t('doctor.hints.dataDirShared'), to: null }
    case 'hook_trust_untrusted':
      return { title, subject: text(data.label), to: null,
        hint: t('doctor.hints.hookTrustUntrusted', { client: text(data.label) }) }
    default:
      return { title, subject: '', hint: '', to: null }
  }
}
