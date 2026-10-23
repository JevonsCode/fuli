import { ApiError, getJson, putJson } from '@/api/client'
import { t } from '@/i18n'
import { shortDigest } from '@/features/data-format/model'
import { formatDateTime } from '@/lib/date-time'
import { shortUniqueIds } from '@/lib/short-ids'

// The console's model settings page (rec#8): each built-in Agent's model,
// budget and egress, edited through the loopback route, and its usage from
// the ledger. Payload shapes follow src/model-backends/port.js (roles, usage)
// and src/model-backends/role-settings.js (the edit). A connection names its
// key by secretRef only; no key reaches this page.

export const MODEL_ROLES = ['assistant', 'bole', 'jefa', 'tonborg'] as const
export type ModelRoleId = typeof MODEL_ROLES[number]
export const MODEL_PROTOCOLS = ['openai_chat', 'anthropic_messages', 'typesafe_systemone'] as const
export type ModelProtocol = typeof MODEL_PROTOCOLS[number]
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const

// Astro's stable id is assistant; the others are named as they are.
const ROLE_NAMES: Record<ModelRoleId, string> = { assistant: 'Astro', bole: 'Bole', jefa: 'Jefa', tonborg: 'Tonborg' }
export const roleName = (role: ModelRoleId) => ROLE_NAMES[role]

export interface ModelPricing {
  currency: string
  inputPerMillionTokens: number
  outputPerMillionTokens: number
  cachedInputPerMillionTokens: number | null
}

export interface ModelConnection {
  protocol: ModelProtocol
  endpoint: string
  model: string
  secretRef: string | null
  reasoningEffort: string | null
  pricing: ModelPricing | null
}

export interface ModelBudget {
  maxInputTokens: number
  maxOutputTokens: number
  timeoutMs: number
  windowHours: number
  maxTokensPerWindow: number
  maxCostPerWindow: number | null
}

export interface ApprovedProject { personalSpaceId: string; personalProjectId: string }

export interface ModelRoleView {
  role: ModelRoleId
  state: 'enabled' | 'disabled' | 'not_configured' | 'invalid_config'
  answeredBy: 'model_api' | 'current_session' | null
  connection?: { id: string; protocol: ModelProtocol; endpointHost: string; model: string; secretRef: string | null }
  allowedOperations?: string[]
  egress?: { approvedProjects: ApprovedProject[]; allowUnassigned: boolean }
  budget?: ModelBudget | null
  fallbackToSession?: boolean
  // rec#10 D-24, read from the gate registry: only Tonborg's model can be unlocked.
  reviewGate?: ReviewGateView
  // rec#10 D-32: the build a local Ollama listed after the latest answer.
  localBuild?: LocalBuild
}

// An observation of the local catalog, never proof of what served an answer.
export interface LocalBuild {
  status: 'not_applicable' | 'no_record' | 'not_observed' | 'observed'
  digest: string | null
  completedAt: string | null
}

// What the 本地模型版本 row says: nothing for a connection a local build is
// never read from; otherwise the state in words, or the build as the
// 12-character prefix `ollama list` shows, with the full build in a title.
export function localBuildText(build: LocalBuild | undefined, locale: string): { text: string; title?: string; code: boolean } | null {
  if (!build || build.status === 'not_applicable') return null
  if (build.status === 'no_record') return { text: t('modelSettings.localBuild.noRecord'), code: false }
  if (build.status === 'not_observed' || !build.digest) {
    return { text: t('modelSettings.localBuild.notObserved'), title: t('modelSettings.localBuild.notObservedHint'), code: false }
  }
  const time = formatDateTime(build.completedAt, locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }, { missing: '' })
  return { text: `${shortDigest(build.digest)}…`, title: `${build.digest}\n${t('modelSettings.localBuild.observedHint', { time })}`, code: true }
}

export interface GateEntry { modelId: string; modelDigest: string; harnessVersion: string; evidence: string; addedAt: string }
export interface ReviewGateView { status: 'suggestion_only' | 'unlocked'; reason: string | null; entries: GateEntry[] }

// The unlocked builds as model@digest prefix; the full builds go in a title.
export function gateBuilds(gate: ReviewGateView): { text: string; title: string } {
  const digests = shortUniqueIds(gate.entries.map(entry => entry.modelDigest))
  return {
    text: gate.entries.map(entry => {
      const short = digests.get(entry.modelDigest) ?? entry.modelDigest
      return `${entry.modelId}@${short}${short === entry.modelDigest ? '' : '…'}`
    }).join(', '),
    title: gate.entries.map(entry => `${entry.modelId}@${entry.modelDigest} (${entry.evidence})`).join('\n'),
  }
}

export interface ModelRolesPayload {
  state: 'ok' | 'absent' | 'invalid'
  error: string | null
  revision: string | null
  connections: Record<string, ModelConnection>
  roles: ModelRoleView[]
  operations: Partial<Record<ModelRoleId, string[]>>
}

export const readModelRoles = (signal?: AbortSignal) =>
  getJson<ModelRolesPayload>('/api/model-backends/roles', { signal })

// What a number field holds: its text, or the number Vue reads from a number input.
type NumberText = string | number

// What the form holds: text for every typed field, converted once on save.
export interface RoleDraft {
  enabled: boolean
  connectionId: string
  protocol: ModelProtocol
  endpoint: string
  model: string
  secretRef: string
  reasoningEffort: string
  priced: boolean
  currency: string
  inputPrice: NumberText
  outputPrice: NumberText
  cachedInputPrice: number | null
  operations: string
  approvedProjects: ApprovedProject[]
  allowUnassigned: boolean
  maxInputTokens: NumberText
  maxOutputTokens: NumberText
  timeoutSeconds: NumberText
  windowHours: NumberText
  maxTokensPerWindow: NumberText
  maxCostPerWindow: NumberText
  fallbackToSession: boolean
}

// A new role starts from the example in fuli PR 236: modest per-call limits,
// a 24-hour window and no project approved for the model API's egress.
const NEW_ROLE_BUDGET: ModelBudget = {
  maxInputTokens: 8000, maxOutputTokens: 600, timeoutMs: 60_000, windowHours: 24, maxTokensPerWindow: 200_000, maxCostPerWindow: null,
}
const NEW_CONNECTION: ModelConnection = {
  protocol: 'openai_chat', endpoint: '', model: '', secretRef: null, reasoningEffort: null, pricing: null,
}

export const projectKey = (project: ApprovedProject) => `${project.personalSpaceId}/${project.personalProjectId}`
const text = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value))

export function roleDraft(payload: ModelRolesPayload, role: ModelRoleId): RoleDraft {
  const view = payload.roles.find(entry => entry.role === role)
  const connectionId = view?.connection?.id ?? role
  const budget = view?.budget ?? NEW_ROLE_BUDGET
  return {
    ...connectionFields(payload.connections[connectionId] ?? NEW_CONNECTION),
    enabled: view?.state === 'enabled',
    connectionId,
    operations: (view?.allowedOperations ?? payload.operations[role] ?? []).join(', '),
    approvedProjects: [...(view?.egress?.approvedProjects ?? [])],
    allowUnassigned: view?.egress?.allowUnassigned ?? false,
    maxInputTokens: text(budget.maxInputTokens),
    maxOutputTokens: text(budget.maxOutputTokens),
    timeoutSeconds: text(budget.timeoutMs / 1000),
    windowHours: text(budget.windowHours),
    maxTokensPerWindow: text(budget.maxTokensPerWindow),
    maxCostPerWindow: text(budget.maxCostPerWindow),
    fallbackToSession: view?.fallbackToSession ?? true,
  }
}

// Switching the connection loads that connection's fields; a new id keeps
// what is typed so far.
export function withConnection(draft: RoleDraft, payload: ModelRolesPayload, connectionId: string): RoleDraft {
  const saved = payload.connections[connectionId]
  return { ...draft, ...(saved ? connectionFields(saved) : {}), connectionId }
}

function connectionFields(connection: ModelConnection) {
  return {
    protocol: connection.protocol,
    endpoint: connection.endpoint,
    model: connection.model,
    secretRef: connection.secretRef ?? '',
    reasoningEffort: connection.reasoningEffort ?? '',
    priced: Boolean(connection.pricing),
    currency: connection.pricing?.currency ?? 'USD',
    inputPrice: text(connection.pricing?.inputPerMillionTokens),
    outputPrice: text(connection.pricing?.outputPerMillionTokens),
    cachedInputPrice: connection.pricing?.cachedInputPerMillionTokens ?? null,
  }
}

// Approves or withdraws one project for egress.
export function withProject(draft: RoleDraft, project: ApprovedProject, approved: boolean): RoleDraft {
  const others = draft.approvedProjects.filter(entry => projectKey(entry) !== projectKey(project))
  return { ...draft, approvedProjects: approved ? [...others, project] : others }
}

// Other roles that use the same connection, so the form says an edit reaches them.
export function rolesSharing(payload: ModelRolesPayload, connectionId: string, role: ModelRoleId): ModelRoleId[] {
  return payload.roles.filter(entry => entry.role !== role && entry.connection?.id === connectionId).map(entry => entry.role)
}

const number = (value: NumberText) => (String(value).trim() === '' ? null : Number(value))

// The body of PUT /api/model-backends/roles/:role. The server validates the
// whole configuration again; an empty optional field is sent as null.
export function roleEdit(draft: RoleDraft, revision: string | null) {
  const secretRef = draft.secretRef.trim()
  const timeoutSeconds = number(draft.timeoutSeconds)
  return {
    revision,
    connectionId: draft.connectionId,
    connection: {
      protocol: draft.protocol,
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
      secretRef: secretRef || null,
      reasoningEffort: draft.protocol === 'openai_chat' && draft.reasoningEffort ? draft.reasoningEffort : null,
      pricing: draft.priced ? {
        currency: draft.currency.trim().toUpperCase(),
        inputPerMillionTokens: number(draft.inputPrice),
        outputPerMillionTokens: number(draft.outputPrice),
        cachedInputPerMillionTokens: draft.cachedInputPrice,
      } : null,
    },
    settings: {
      enabled: draft.enabled,
      allowedOperations: draft.operations.split(/[,，\s]+/).filter(Boolean),
      egress: {
        approvedProjects: draft.approvedProjects,
        allowUnassigned: draft.allowUnassigned,
      },
      budget: {
        maxInputTokens: number(draft.maxInputTokens),
        maxOutputTokens: number(draft.maxOutputTokens),
        timeoutMs: timeoutSeconds === null ? null : Math.round(timeoutSeconds * 1000),
        windowHours: number(draft.windowHours),
        maxTokensPerWindow: number(draft.maxTokensPerWindow),
        maxCostPerWindow: draft.priced ? number(draft.maxCostPerWindow) : null,
      },
      fallbackToSession: draft.fallbackToSession,
    },
  }
}

// The two 409s of a save: the file changed since it was read, or it no longer
// validates. Either way the page reads the settings again.
export type ConfigConflict = 'model_config_changed' | 'model_config_invalid'
export function configConflict(cause: unknown): ConfigConflict | null {
  if (!(cause instanceof ApiError) || cause.status !== 409) return null
  try {
    const code = (JSON.parse(cause.detail) as { code?: unknown }).code
    return code === 'model_config_changed' || code === 'model_config_invalid' ? code : null
  } catch {
    return null
  }
}

export const saveModelRole = (role: ModelRoleId, draft: RoleDraft, revision: string | null) =>
  putJson<ModelRolesPayload>(`/api/model-backends/roles/${role}`, roleEdit(draft, revision))

// ---- Usage ----------------------------------------------------------------

export const USAGE_WINDOWS = ['today', '7d', '30d'] as const
export type UsageWindow = typeof USAGE_WINDOWS[number]
const DAY_MS = 24 * 60 * 60 * 1000

// Today starts at the person's local midnight; the others count back from now.
export function usageWindowStart(window: UsageWindow, now = new Date()): string {
  if (window === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  return new Date(now.getTime() - (window === '7d' ? 7 : 30) * DAY_MS).toISOString()
}

// reported is null when no attempt in the group reported it: unknown, never 0.
export interface TokenCell { reported: number | null; unknownAttempts: number }

export interface UsageGroup {
  role: ModelRoleId
  provider: string | null
  model: string | null
  actualModels: string[]
  channel: 'model_api' | 'session'
  requests: number
  attempts: number
  failedAttempts: number
  tokens: Partial<Record<'input' | 'output' | 'total' | 'cachedInput' | 'cacheWriteInput' | 'reasoning', TokenCell>>
  estimatedCost: { amount: number | null; currency: string; basis: 'estimate'; unknownAttempts: number } | null
}

export interface UsagePayload { groups: UsageGroup[] }

export const readModelUsage = (window: UsageWindow, signal?: AbortSignal) =>
  getJson<UsagePayload>(`/api/model-backends/usage?from=${encodeURIComponent(usageWindowStart(window))}`, { signal })

// What a usage cell says: a known value, a known part with the attempts that
// reported nothing, or nothing reported at all.
export type UsageValue =
  | { kind: 'known'; value: number }
  | { kind: 'partial'; value: number; unknown: number }
  | { kind: 'unknown'; unknown: number }

export function tokenValue(cell: TokenCell | undefined, attempts: number): UsageValue {
  if (!cell || cell.reported === null) return { kind: 'unknown', unknown: cell?.unknownAttempts ?? attempts }
  return cell.unknownAttempts ? { kind: 'partial', value: cell.reported, unknown: cell.unknownAttempts } : { kind: 'known', value: cell.reported }
}

export function costValue(group: UsageGroup): UsageValue & { currency?: string } {
  const cost = group.estimatedCost
  if (!cost || cost.amount === null) return { kind: 'unknown', unknown: cost?.unknownAttempts ?? group.attempts }
  return cost.unknownAttempts
    ? { kind: 'partial', value: cost.amount, unknown: cost.unknownAttempts, currency: cost.currency }
    : { kind: 'known', value: cost.amount, currency: cost.currency }
}

export interface UsageRow {
  key: string
  group: UsageGroup
  // Known total tokens against the largest known total in its list, for the bar; null when unknown.
  share: number | null
}

// Model API rows and current-session fallbacks are kept apart: a session's
// usage is whatever the client reported and never counts as the model's.
export function usageRows(groups: UsageGroup[]): { model: UsageRow[]; session: UsageRow[] } {
  const rows = (channel: UsageGroup['channel']) => {
    const list = groups.filter(group => group.channel === channel)
    const largest = Math.max(0, ...list.map(group => group.tokens.total?.reported ?? 0))
    return list.map(group => ({
      key: [group.role, group.channel, group.provider, group.model, group.estimatedCost?.currency].join('|'),
      group,
      share: group.tokens.total?.reported === null || group.tokens.total?.reported === undefined || !largest
        ? null : group.tokens.total.reported / largest,
    }))
  }
  return { model: rows('model_api'), session: rows('session') }
}

// One usage cell in words: 未上报 with the number of attempts that reported
// nothing, never 0. A partly reported value keeps its note apart, so the
// note wraps as a whole instead of breaking inside a word.
export function usageParts(value: UsageValue, locale: string, currency?: string): { value: string; note: string } {
  if (value.kind === 'unknown') return { value: t('modelSettings.usage.notReportedCount', { count: value.unknown }), note: '' }
  const shown = currency
    ? new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 6 }).format(value.value)
    : formatCount(value.value, locale)
  return { value: shown, note: value.kind === 'partial' ? t('modelSettings.usage.partialNote', { count: value.unknown }) : '' }
}

export const formatCount = (value: number, locale: string) => new Intl.NumberFormat(locale).format(value)
