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

export interface DoctorItemView {
  title: string
  subject: string
  hint: string
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

// One item in plain words: never its kind code. A kind this console does not
// know yet still reads as something to look at.
export function doctorItemView(item: DoctorItem): DoctorItemView {
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
    case 'sessions_outdated':
      return { title, subject: sourceApplicationName(text(data.client) as ConversationSourceApplication) ?? t('doctor.otherClient'),
        hint: t('doctor.hints.sessions', { count: Number(data.count) || 0, version: text(data.runningVersion) }), to: null }
    case 'update_left_work':
      return { title, subject: '', to: null, hint: data.status === 'failed'
        ? t('doctor.hints.updateFailed', { reason: text(data.error) })
        : t('doctor.hints.updateReconnect') }
    default:
      return { title, subject: '', hint: '', to: null }
  }
}
