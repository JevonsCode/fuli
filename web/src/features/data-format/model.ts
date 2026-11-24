import { z } from 'zod'
import { ApiError, getJson, postJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
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
  // Records the step could not read and left as they were.
  unreadable?: number
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

// What the page reads of each answer (src/data-format/migration-plan.js,
// migration-operations.js, console-restore.js). The unions stay with the
// interfaces here, so a kind is checked as text; a field the server may leave
// out or null is optional.
const stepSchema = z.looseObject({
  id: z.string(), summary: z.string(), fromVersion: z.number(), toVersion: z.number(), count: z.number(),
  sampleIds: z.array(z.string()),
})
const storePlanSchema = z.looseObject({
  label: z.string(), store: z.string(), kind: z.string(), automatic: z.array(z.string()), step: stepSchema,
  undo: z.string(), warning: z.string().nullish(), digest: z.string(),
})
const blockedSchema = z.looseObject({ label: z.string(), store: z.string(), steps: z.array(z.string()), reason: z.string() })
const undoableSchema = z.looseObject({
  label: z.string(), store: z.string(), migrationId: z.string(), fromVersion: z.number(), toVersion: z.number(),
  reversible: z.boolean().nullish(),
})
const noticeSchema = z.looseObject({
  active: z.array(z.looseObject({ id: z.string(), migrationId: z.string(), remaining: z.number() })),
  unavailable: z.boolean().nullish(),
})
const pruneEntrySchema = z.looseObject({
  kind: z.string(), store: z.string().nullish(),
  auditError: z.looseObject({ code: z.string(), message: z.string() }).nullish(),
})
const planShape = shapeFor<MigrationPlan>(z.looseObject({
  digest: z.string().nullable(),
  stores: z.array(storePlanSchema),
  blocked: z.array(blockedSchema),
  undoable: z.array(undoableSchema),
  // retentionPolicyOrNull() is null when the budget setting is invalid.
  retention: z.looseObject({ keep: z.number(), maxBytes: z.number() }).nullish(),
  notice: noticeSchema.nullish(),
}))
const outcomeShape = shapeFor<ApplyOutcome>(z.looseObject({
  status: z.string(),
  results: z.array(z.looseObject({
    label: z.string(), status: z.string(), migrationId: z.string(), code: z.string().nullish(), message: z.string().nullish(),
  })),
  skipped: z.array(z.looseObject({ label: z.string(), migrationId: z.string() })),
  pruned: z.array(pruneEntrySchema).nullish(),
}))
const noticeResultShape = shapeFor<{ notice: MigrationNotice }>(z.looseObject({ notice: noticeSchema }))
// adapted: records written since the step that the undo brought into the earlier format.
const undoShape = shapeFor<{ status: string; version: number; adapted?: number | null; pruned?: PruneEntry[] }>(z.looseObject({
  status: z.string(), version: z.number(), adapted: z.number().nullish(), pruned: z.array(pruneEntrySchema).nullish(),
}))
const pruneShape = shapeFor<{ pruned: PruneEntry[] }>(z.looseObject({ pruned: z.array(pruneEntrySchema) }))

export const readMigrationPlan = (signal?: AbortSignal) => getJson('/api/data-format', planShape, { signal })
export const applyMigrationPlan = (digest: string) => postJson('/api/data-format/apply', { digest }, outcomeShape)
export const dismissMigrationNotices = (ids: string[]) =>
  postJson('/api/data-format/dismiss-notices', { ids }, noticeResultShape)
export const undoMigration = (label: string, migrationId: string) =>
  postJson('/api/data-format/rollback', { label, migrationId }, undoShape)

// The person's check of a graph prune whose answer never came: the same prune again.
export const pruneAgain = () => postJson('/api/data-format/prune', {}, pruneShape)

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

// consoleRestore.status() is null until a restore has run.
const restoreStatusSchema = z.looseObject({
  id: z.string(), label: z.string(), backupRef: z.string(), status: z.string(),
  safetyBackupRef: z.string().nullable(), started: z.boolean().nullable(), error: z.string().nullable(),
})
const restoreStatusShape = shapeFor<RestoreStatus>(restoreStatusSchema)
const restoreStatusAnswerShape = shapeFor<{ restore: RestoreStatus | null }>(z.looseObject({ restore: restoreStatusSchema.nullable() }))
const restoreChoicesShape = shapeFor<{ stores: RestorableStore[]; restore: RestoreStatus | null }>(z.looseObject({
  stores: z.array(z.looseObject({
    label: z.string(), store: z.string(), kind: z.string(),
    backups: z.array(z.looseObject({ ref: z.string(), version: z.number().nullish(), takenAt: z.string().nullish() })),
  })),
  restore: restoreStatusSchema.nullable(),
}))
const restoreImpactShape = shapeFor<{ impact: RestoreImpact }>(z.looseObject({
  impact: z.looseObject({
    store: z.string(), backupRef: z.string(), takenAt: z.string().nullish(), currentVersion: z.number().nullish(),
    backupVersion: z.number().nullish(),
    tables: z.array(z.looseObject({ table: z.string(), current: z.number(), backup: z.number() })).nullish(),
    laterMigrations: z.array(z.looseObject({ migrationId: z.string(), status: z.string() })),
    currentDigest: z.string().nullable(),
  }),
}))

export const readRestoreChoices = () => getJson('/api/data-format/restore', restoreChoicesShape)
export const describeRestore = (label: string, backupRef: string) => getJson(
  `/api/data-format/restore?${new URLSearchParams({ label, backup: backupRef })}`, restoreImpactShape)
export const startRestore = (label: string, backupRef: string, currentDigest: string | null) =>
  postJson('/api/data-format/restore', { label, backupRef, currentDigest }, restoreStatusShape)
export const readRestoreStatus = () => getJson('/api/data-format/restore/status', restoreStatusAnswerShape)

export function restoreFinished(status: RestoreStatus | null, id: string): boolean {
  return status?.id === id && (status.status === 'restored' || status.status === 'failed')
}

// The graph step's whole-graph backup and, when an undo is refused, its
// restore (src/data-format/console-graph-backup.js): the same export and
// import a terminal runs. FULI stops while either runs, so the page asks for
// the job's outcome until the console answers again.
export interface GraphBackupCopy { name: string; path: string; createdAt: string; bytes: number }
export type GraphBackupStep = 'stopping' | 'exporting' | 'restoring' | 'starting' | 'checking'
export interface GraphBackupJob {
  id: string
  action: 'backup' | 'restore'
  status: 'running' | 'done' | 'failed'
  step: GraphBackupStep | null
  version: number
  backup: GraphBackupCopy | null
  error: string | null
  started: boolean | null
  // A finished backup: from before the confirmation (true), the step was confirmed meanwhile (false), or not checked (null).
  beforeConfirmation?: boolean | null
  // A backup asked for while this one ran: the page follows this one.
  joined?: boolean
}
export interface GraphBackupView {
  latest: GraphBackupCopy | null
  // How big the export can get (null: a container's volume cannot be measured first) and the room for it.
  room: { bytes: number | null; freeBytes: number | null }
  job: GraphBackupJob | null
}

const graphBackupCopy = z.looseObject({ name: z.string(), path: z.string(), createdAt: z.string(), bytes: z.number() })
const graphBackupJob = z.looseObject({
  id: z.string(), action: z.string(), status: z.string(), step: z.string().nullable(), version: z.number(),
  backup: graphBackupCopy.nullable(), error: z.string().nullable(), started: z.boolean().nullable(),
})
const graphBackupJobShape = shapeFor<GraphBackupJob>(graphBackupJob)
const graphBackupViewShape = shapeFor<GraphBackupView>(z.looseObject({
  latest: graphBackupCopy.nullable(),
  room: z.looseObject({ bytes: z.number().nullable(), freeBytes: z.number().nullable() }),
  job: graphBackupJob.nullable(),
}))

export const readGraphBackup = (version: number) =>
  getJson(`/api/data-format/graph-backup?${new URLSearchParams({ version: String(version) })}`, graphBackupViewShape)
export const startGraphBackup = (version: number) => postJson('/api/data-format/graph-backup', { version }, graphBackupJobShape)
export const startGraphRestore = (version: number, name: string) =>
  postJson('/api/data-format/graph-backup/restore', { version, name }, graphBackupJobShape)
export const revealGraphBackup = (version: number, name: string) =>
  postJson('/api/data-format/graph-backup/reveal', { version, name }, shapeFor<{ revealed: boolean }>(z.looseObject({ revealed: z.boolean() })))

export function graphBackupFinished(job: GraphBackupJob | null, id: string): job is GraphBackupJob {
  return job?.id === id && job.status !== 'running'
}

// A confirmation or undo refused while a graph backup or restore stops and starts FULI.
export const GRAPH_JOB_RUNNING = new Set(['graph_backup_running', 'graph_restore_running'])

// An undo of the graph step refused because records changed since: only a whole-graph restore goes back.
export const UNDO_NEEDS_RESTORE = new Set(['data_format_changed_since', 'data_format_undo_blocked'])

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
