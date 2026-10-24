import { getJson } from '@/api/client'
import { i18n, t } from '@/i18n'

import { formatCount, roleName, type ModelRoleId } from './model'

// 变更记录 of one role on the model settings page (rec#11 D-42): what changed
// in its effective settings and execution mode, and when, newest first, as
// src/model-backends/settings-history.js records it. A change saved through
// another role sharing the connection names that role (via). Three markers
// say what is missing, without naming a cause: on top, current settings no
// record reaches; between two records, changes not recorded there; at the
// end, changes made before anything was recorded. A key reference is only
// ever "changed".

export type HistoryKind = 'settings' | 'suggestions_only' | 'warning_acknowledged'
export type FieldChange = { field: string; before: unknown; after: unknown } | { field: string; changed: true }

export type HistoryEntry =
  | { kind: HistoryKind; changeId: string; changedAt: string; role: ModelRoleId; fromRevision: string | null; toRevision: string;
    changes: FieldChange[]; via: ModelRoleId | null }
  | { kind: 'unrecorded_changes' | 'unrecorded_gap' | 'earlier_changes_not_recorded'; changedAt: null; role: ModelRoleId | null }

export const readModelSettingsHistory = (role: ModelRoleId, signal?: AbortSignal) =>
  getJson<{ entries?: HistoryEntry[] }>(`/api/model-backends/history?${new URLSearchParams({ role })}`, { signal })
    .then(body => body.entries ?? [])

// Field paths named by the label the settings form already uses.
const FIELD_LABELS: Record<string, string> = {
  'settings.enabled': 'modelSettings.enabled',
  'settings.allowedOperations': 'modelSettings.operations',
  'settings.egress.approvedProjects': 'modelSettings.egressProjectsLabel',
  'settings.egress.allowUnassigned': 'modelSettings.allowUnassigned',
  'settings.budget.maxInputTokens': 'modelSettings.maxInputTokens',
  'settings.budget.maxOutputTokens': 'modelSettings.maxOutputTokens',
  'settings.budget.timeoutMs': 'modelSettings.timeoutSeconds',
  'settings.budget.windowHours': 'modelSettings.windowHours',
  'settings.budget.maxTokensPerWindow': 'modelSettings.maxTokensPerWindow',
  'settings.budget.maxCostPerWindow': 'modelSettings.maxCostPerWindow',
  'settings.fallbackToSession': 'modelSettings.fallback',
  connection: 'modelSettings.connection',
  'connection.protocol': 'modelSettings.protocol',
  'connection.endpoint': 'modelSettings.endpoint',
  'connection.model': 'modelSettings.model',
  'connection.secretRef': 'modelSettings.secretRef',
  'connection.reasoningEffort': 'modelSettings.reasoningEffort',
  'connection.pricing.currency': 'modelSettings.currency',
  'connection.pricing.inputPerMillionTokens': 'modelSettings.inputPrice',
  'connection.pricing.outputPerMillionTokens': 'modelSettings.outputPrice',
}

// An unknown field keeps its path, so a newer FULI's record still reads.
const fieldLabel = (field: string) => (FIELD_LABELS[field] ? t(FIELD_LABELS[field]) : field)

function valueText(field: string, value: unknown, locale: string): string {
  if (value === null || value === undefined) return t('modelSettings.none')
  if (typeof value === 'boolean') return t(value ? 'modelSettings.history.on' : 'modelSettings.history.off')
  if (field === 'settings.budget.timeoutMs' && typeof value === 'number') return formatCount(value / 1000, locale)
  if (field === 'connection.protocol' && i18n.global.te(`modelSettings.protocols.${value}`)) return t(`modelSettings.protocols.${value}`)
  if (typeof value === 'number') return formatCount(value, locale)
  if (field === 'settings.egress.approvedProjects' && Array.isArray(value)) return t('modelSettings.egressProjects', { count: value.length })
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('modelSettings.none')
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// One plain line per change of a recorded entry (after the role it was saved through), or the marker's one line.
export function historyLines(entry: HistoryEntry, locale: string): string[] {
  if (entry.changedAt === null) return [t(`modelSettings.history.markers.${entry.kind}`)]
  if (entry.kind === 'warning_acknowledged') return [t('modelSettings.history.warningAcknowledged')]
  const via = entry.via ? [t('modelSettings.history.via', { name: roleName(entry.via) })] : []
  return [...via, ...entry.changes.map((change) => {
    if (entry.kind === 'suggestions_only' && 'after' in change) {
      return t(change.after ? 'modelSettings.history.suggestionsOnlyOn' : 'modelSettings.history.suggestionsOnlyOff')
    }
    if (!('after' in change)) return t('modelSettings.history.referenceChanged', { field: fieldLabel(change.field) })
    return t('modelSettings.history.fieldChanged', { field: fieldLabel(change.field),
      before: valueText(change.field, change.before, locale), after: valueText(change.field, change.after, locale) })
  })]
}
