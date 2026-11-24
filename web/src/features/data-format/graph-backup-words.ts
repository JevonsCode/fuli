import { t } from '@/i18n'
import type { GraphBackupJob } from './model'

// What the page says while a graph backup or restore runs (its real step,
// src/data-format/console-graph-backup.js) and when one did not start.

export function graphJobLabel(job: GraphBackupJob): string {
  const area = job.action === 'restore' ? 'graphRestore' : 'graphBackup'
  return t(`dataFormat.${area}.steps.${job.step ?? 'preparing'}`)
}

const REFUSALS = new Set(['graph_import_unfinished', 'graph_lifecycle_locked', 'graph_backup_no_space', 'graph_backup_unknown',
  'graph_backup_not_waiting', 'graph_backup_running', 'graph_restore_running', 'format_restore_running', 'update_running'])

// A start the server refused: from another computer (where to do it instead),
// for a reason the page words, or the server's own text.
export function graphRefusal(refusal: { code: string | null; hostOnly: boolean; message: string },
  area: 'graphBackup' | 'graphRestore'): { text: string; hostOnly: boolean } {
  if (refusal.hostOnly) return { text: t('dataFormat.graphBackup.hostOnly'), hostOnly: true }
  const reason = refusal.code && REFUSALS.has(refusal.code) ? t(`dataFormat.graphBackup.refused.${refusal.code}`) : refusal.message
  return { text: t(`dataFormat.${area}.notStarted`, { reason }), hostOnly: false }
}
