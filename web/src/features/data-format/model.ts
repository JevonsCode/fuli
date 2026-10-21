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
}

export interface MigrationResult {
  label: string
  status: 'applied' | 'already_applied' | 'failed'
  migrationId: string
  count?: number
  code?: string
  message?: string
}

export interface ApplyOutcome {
  status: 'applied' | 'partial' | 'failed'
  results: MigrationResult[]
  skipped: { label: string; migrationId: string }[]
}

export const readMigrationPlan = (signal?: AbortSignal) => getJson<MigrationPlan>('/api/data-format', { signal })
export const applyMigrationPlan = (digest: string) => postJson<ApplyOutcome>('/api/data-format/apply', { digest })
export const undoMigration = (label: string, migrationId: string) =>
  postJson<{ status: string; version: number }>('/api/data-format/rollback', { label, migrationId })

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
