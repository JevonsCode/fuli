import { currentLocale, t } from '@/i18n'
import type { AgentAppRow } from './agent-apps'

// How an app reads in the list: which group it sits in and its one status line.
// Everything comes from the app's recorded status, versions, run gate and
// instance; nothing is guessed.
export type AppGroup = 'attention' | 'running' | 'ready' | 'removed'
export type AppTone = 'attention' | 'running' | 'quiet' | 'danger'

const REMOVED = new Set(['code_deleted', 'data_deleting', 'deleted'])
const CONFIRMATION_REASONS = new Set(['confirmation_required', 'reconfirmation_required', 'challenge_mismatch', 'runner_check_failed'])
const known = (key: string, fallback: string) => { const label = t(key); return label === key ? fallback : label }

const isRunning = (app: AgentAppRow) => ['running', 'sealing'].includes(app.instance?.state ?? '')
/** An active app the run gate refuses: it cannot run until the person confirms it at a terminal. */
const needsConfirmation = (app: AgentAppRow) => app.status === 'active' && app.run.status === 'run_refused'
  && CONFIRMATION_REASONS.has(app.run.reason ?? '')

export function appGroup(app: AgentAppRow): AppGroup {
  if (REMOVED.has(app.status)) return 'removed'
  if (app.pendingVersions.length || needsConfirmation(app)) return 'attention'
  if (isRunning(app)) return 'running'
  return 'ready'
}

/** The app's one status line and its tone. */
export function appStatus(app: AgentAppRow): { text: string; tone: AppTone } {
  if (app.status === 'deleted') return { text: t('agentApps.status.deleted'), tone: 'quiet' }
  if (app.status === 'data_deleting') return { text: t('agentApps.status.dataDeleting'), tone: 'danger' }
  if (app.status === 'code_deleted') return { text: t('agentApps.status.codeDeleted', { size: formatBytes(app.dataBytes) }), tone: 'quiet' }
  const pending = app.pendingVersions.at(-1)
  if (pending) return { text: t('agentApps.status.pending', { version: pending }), tone: 'attention' }
  if (app.status === 'disabled') return { text: t('agentApps.status.disabled'), tone: 'quiet' }
  if (needsConfirmation(app)) return { text: known(`agentApps.refusals.${app.run.reason}`, t('agentApps.refusals.confirmation_required')), tone: 'attention' }
  if (isRunning(app)) return { text: t('agentApps.status.running'), tone: 'running' }
  const exit = app.instance?.exit?.category
  if (exit && exit !== 'exited') return { text: known(`agentApps.exits.${exit}`, exit), tone: 'danger' }
  return { text: t('agentApps.status.ready'), tone: 'quiet' }
}

export const appTypeLabel = (type: string | null) => (type ? known(`agentApps.types.${type}`, type) : t('agentApps.types.unknown'))
export const versionStateLabel = (state: string) => known(`agentApps.versionStates.${state}`, state)
export const historyLabel = (action: string) => known(`agentApps.history.${action}`, action)

/** A data size in the reader's language: bytes, KB or MB, one decimal at most. */
export function formatBytes(bytes: number): string {
  const units = [['megabyte', 1024 * 1024], ['kilobyte', 1024]] as const
  const [unit, size] = units.find(([, size]) => bytes >= size) ?? ['byte', 1]
  return new Intl.NumberFormat(currentLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / size)
}
