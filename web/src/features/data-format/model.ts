import { ApiError, getJson, postJson } from '@/api/client'
import { shortUniqueIds } from '@/lib/short-ids'

// The console's view of `fuli migrate preview` (rec#17 D-09 part 2): the
// stores with a step waiting for a person, by step ID, count and sample IDs;
// never record content. Payload shapes follow src/data-format/migration-plan.js.

export interface MigrationStep {
  id: string
  summary: string
  kind: string
  fromVersion: number
  toVersion: number
  count: number
  sampleIds: string[]
}

export interface StorePlan {
  label: string
  store: string
  kind: 'sqlite' | 'json' | 'neo4j'
  action: 'apply'
  automatic: string[]
  step: MigrationStep
  undo: 'available' | 'restore_only'
  // What no undo brings back (a step that deletes), said before confirming.
  warning?: string
  digest: string
}

export interface BlockedStore {
  label: string
  store: string
  action: 'blocked' | 'unavailable'
  steps: string[]
  reason: string
}

export interface UndoableMigration {
  label: string
  store: string
  migrationId: string
  fromVersion: number
  toVersion: number
  reversible?: boolean
}

export interface MigrationPlan {
  digest: string | null
  stores: StorePlan[]
  blocked: BlockedStore[]
  undoable: UndoableMigration[]
  // The one budget format backups and graph undo journals share.
  retention?: { keep: number; maxBytes: number } | null
  notice?: MigrationNotice
}

export interface MigrationNotice {
  active: { id: string; migrationId: string; remaining: number }[]
  unavailable?: boolean
}

export interface MigrationResult {
  label: string
  status: 'applied' | 'already_applied' | 'failed'
  migrationId: string
  count?: number
  code?: string
  message?: string
}

// What retention did after the change: a graph prune whose answer never came is 'prune_unverified'.
// auditError: the local operations log could not record it; the result stands.
export interface PruneEntry {
  kind: 'pruned' | 'prune_failed' | 'prune_unverified' | 'audit_failed'
  store?: string
  auditError?: { code: string; message: string }
}

export interface ApplyOutcome {
  status: 'applied' | 'partial' | 'failed'
  results: MigrationResult[]
  skipped: { label: string; migrationId: string }[]
  pruned?: PruneEntry[]
}

export function pruneUnverified(pruned: PruneEntry[] | undefined): boolean {
  return (pruned ?? []).some(entry => entry.kind === 'prune_unverified')
}

export function pruneAuditError(pruned: PruneEntry[] | undefined): string {
  return (pruned ?? []).find(entry => entry.auditError)?.auditError?.message ?? ''
}

export const readMigrationPlan = (signal?: AbortSignal) => getJson<MigrationPlan>('/api/data-format', { signal })
export const applyMigrationPlan = (digest: string) => postJson<ApplyOutcome>('/api/data-format/apply', { digest })
export const dismissMigrationNotices = (ids: string[]) =>
  postJson<{ notice: MigrationNotice }>('/api/data-format/dismiss-notices', { ids })
export const undoMigration = (label: string, migrationId: string) =>
  postJson<{ status: string; version: number; pruned?: PruneEntry[] }>('/api/data-format/rollback', { label, migrationId })

// The person's check of a graph prune whose answer never came: the same prune again.
export const pruneAgain = () => postJson<{ pruned: PruneEntry[] }>('/api/data-format/prune', {})

// What a check of the prune found: still unverified, the graph out of reach, or checked.
export function pruneCheckOutcome(pruned: PruneEntry[]): { kind: 'unverified' | 'unreached' | 'checked'; count: number } {
  const count = pruned.filter(entry => entry.kind === 'pruned').length
  if (pruneUnverified(pruned)) return { kind: 'unverified', count }
  if (pruned.some(entry => entry.kind === 'prune_failed')) return { kind: 'unreached', count }
  return { kind: 'checked', count }
}

// A whole-store restore (src/data-format/console-restore.js): local stores
// with format backups, what one backup discards, and the restore the console
// runs by restarting FULI around it.
export interface FormatBackup { ref: string; version: number | null; takenAt: string | null }
export interface RestorableStore { label: string; store: string; kind: 'sqlite' | 'json'; backups: FormatBackup[] }
export interface RestoreImpact {
  store: string
  backupRef: string
  takenAt: string | null
  currentVersion: number | null
  backupVersion: number | null
  tables?: { table: string; current: number; backup: number }[]
  laterMigrations: { migrationId: string; status: string }[]
  currentDigest: string | null
}
export interface RestoreStatus {
  id: string
  label: string
  backupRef: string
  status: 'stopping' | 'restoring' | 'starting' | 'restored' | 'failed'
  safetyBackupRef: string | null
  started: boolean | null
  error: string | null
}

export const readRestoreChoices = () =>
  getJson<{ stores: RestorableStore[]; restore: RestoreStatus | null }>('/api/data-format/restore')
export const describeRestore = (label: string, backupRef: string) => getJson<{ impact: RestoreImpact }>(
  `/api/data-format/restore?${new URLSearchParams({ label, backup: backupRef })}`)
export const startRestore = (label: string, backupRef: string, currentDigest: string | null) =>
  postJson<RestoreStatus>('/api/data-format/restore', { label, backupRef, currentDigest })
export const readRestoreStatus = () => getJson<{ restore: RestoreStatus | null }>('/api/data-format/restore/status')

export function restoreFinished(status: RestoreStatus | null, id: string): boolean {
  return status?.id === id && (status.status === 'restored' || status.status === 'failed')
}

export interface SampleChip { id: string; text: string; cut: boolean }

// Sample IDs as chips: a unique prefix with … for a cut, the full ID kept for a title.
export function sampleChips(step: MigrationStep): SampleChip[] {
  const short = shortUniqueIds(step.sampleIds)
  return step.sampleIds.map(id => ({ id, text: short.get(id) ?? id, cut: (short.get(id) ?? id) !== id }))
}

export function moreRecords(step: MigrationStep): number {
  return Math.max(0, step.count - step.sampleIds.length)
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

// A refused confirmation's code from the server's JSON error, if any.
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  try {
    const body = JSON.parse(error.detail) as { code?: unknown }
    return typeof body.code === 'string' ? body.code : null
  } catch {
    return null
  }
}

export function refusalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.detail) as { error?: unknown }
      if (typeof body.error === 'string') return body.error
    } catch { /* plain text detail */ }
  }
  return error instanceof Error ? error.message : String(error)
}
