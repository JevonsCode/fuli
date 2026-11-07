import { ApiError, apiErrorCode, getJson, postJson, putJson } from '@/api/client'
import { t } from '@/i18n'
import { roleName as builtInRoleName } from '@/features/agent-profile/role-names'
import { shortDigest } from '@/features/data-format/model'
import { formatDateTime } from '@/lib/date-time'
import { websitePageUrl } from '@/lib/website'

// The console's model settings page (rec#8): each built-in Agent's model,
// budget and egress, edited through the loopback route, and its usage from
// the ledger. Payload shapes follow src/model-backends/port.js (roles, usage)
// and src/model-backends/role-settings.js (the edit). A connection names its
// key by secretRef; the page can save a key under that name, but no key is
// ever sent back to it.

// semantic is no Agent: the person's own model for 语义搜索 (rec#88), which
// only takes the embeddings protocol; the Agents take every other one.
export const SEMANTIC_ROLE = 'semantic'
export const MODEL_ROLES = ['assistant', 'bole', 'jefa', 'tonborg', SEMANTIC_ROLE] as const
export type ModelRoleId = typeof MODEL_ROLES[number]
const EMBEDDING_PROTOCOL = 'openai_embeddings'
export const MODEL_PROTOCOLS = ['openai_chat', 'anthropic_messages', 'typesafe_systemone'] as const
export type ModelProtocol = typeof MODEL_PROTOCOLS[number] | typeof EMBEDDING_PROTOCOL
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const

// A role by the name it goes by now; Astro's stable id is assistant.
export const roleName = (role: ModelRoleId) => (role === SEMANTIC_ROLE ? t('modelSettings.semantic.title')
  : builtInRoleName(role === 'assistant' ? 'astro' : role))

// Addresses the address field suggests, by the protocol they speak. Any
// other OpenAI-compatible address works the same; these only save typing.
const ENDPOINTS = {
  ollama: 'http://127.0.0.1:11434/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
} as const
type KnownEndpoint = keyof typeof ENDPOINTS
// 语义搜索's local Ollama is its own choice, and DeepSeek has no vectors.
const SUGGESTED: Partial<Record<ModelProtocol, readonly KnownEndpoint[]>> = {
  openai_chat: ['ollama', 'qwen', 'deepseek', 'openai'],
  openai_embeddings: ['qwen', 'openai'],
  anthropic_messages: ['anthropic'],
}

export const endpointSuggestions = (protocol: ModelProtocol) => (SUGGESTED[protocol] ?? [])
  .map(name => ({ value: ENDPOINTS[name], label: ENDPOINTS[name], meta: t(`modelSettings.endpointNames.${name}`) }))

// 语义搜索's two choices: this computer's Ollama, or any online
// OpenAI-compatible service (a saved 千问 address is one of them).
export const SEMANTIC_PRESETS = ['ollama', 'online'] as const
export type SemanticPreset = typeof SEMANTIC_PRESETS[number]

export function semanticPreset(endpoint: string): SemanticPreset {
  return endpoint.trim().replace(/\/+$/, '') === ENDPOINTS.ollama ? 'ollama' : 'online'
}

// A local Ollama needs no key; 在线服务 empties the Ollama address, so the person types or picks theirs.
export function withSemanticPreset(draft: RoleDraft, preset: SemanticPreset): RoleDraft {
  if (preset === 'online') return semanticPreset(draft.endpoint) === 'online' ? draft : { ...draft, endpoint: '' }
  return { ...draft, endpoint: ENDPOINTS.ollama, secretRef: '' }
}

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
  headers?: Record<string, string>
  pricing: ModelPricing | null
}

export interface ModelBudget {
  maxInputTokens: number | null
  maxOutputTokens: number | null
  timeoutMs: number | null
  windowHours: number | null
  maxTokensPerWindow: number | null
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
  // rec#10 D-36: whether the role's own model carries out its automatic operation now; null when it has none.
  trust?: RoleTrust | null
  // rec#10 D-32: the build a local Ollama listed after the latest answer.
  localBuild?: LocalBuild
  // rec#92: whether the configured model answered on its latest call; null without a connection.
  health?: ModelRoleHealth | null
}

export interface ModelRoleHealth { status: 'ok' | 'failing' | 'unknown'; at: string | null; reason: string | null }

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

// rec#10 D-36 (src/model-backends/role-trust.js): the person's 「只给建议」
// choice, whether they acknowledged the warning, and whether the configured
// model would execute by itself now (reason says why not).
export interface RoleTrust {
  operation: string
  suggestionsOnly: boolean
  warningSeen: boolean
  warningSeenAt: string | null
  warningVersion: number
  revision: number
  status: 'automatic' | 'suggestion'
  reason: string | null
  evaluation: ModelEvaluation | null
}

// One evaluation of the configured model on this computer (evaluation-record.js).
export interface ModelEvaluation {
  role: string
  operation: string
  model: string
  set: string
  evaluatedAt: string
  agreed: number
  total: number
}

const TRUST_REASONS = ['suggestions_only', 'warning_not_seen', 'session_answer', 'not_configured'] as const

// What the 执行方式 line says: who executes now, or why it only suggests.
export function trustStatusText(trust: RoleTrust, model: string | null): string {
  if (trust.status === 'automatic') return t('modelSettings.trust.automatic', { model: model ?? '' })
  const reason = TRUST_REASONS.find(known => known === trust.reason) ?? 'other'
  return t(`modelSettings.trust.reasons.${reason}`)
}

// The one evaluation line, naming its set, day and model; it is not a general accuracy.
export function evaluationText(evaluation: ModelEvaluation | null, locale: string): string | null {
  if (!evaluation) return null
  const date = formatDateTime(evaluation.evaluatedAt, locale, { year: 'numeric', month: '2-digit', day: '2-digit' }, { missing: '' })
  return t('modelSettings.trust.evaluation', { date, set: evaluation.set, model: evaluation.model,
    rate: Math.round((evaluation.agreed / evaluation.total) * 100) })
}

// The person's change of a role's execution mode, or their acknowledgement of its warning (loopback only).
export type RoleTrustChange = { suggestionsOnly: boolean } | { acknowledgeWarning: number }
export const saveRoleTrust = (role: ModelRoleId, change: RoleTrustChange, expectedRevision: number) =>
  putJson<ModelRolesPayload>(`/api/model-backends/roles/${role}/trust`, { expectedRevision, ...change })

export interface ModelRolesPayload {
  state: 'ok' | 'absent' | 'invalid'
  error: string | null
  revision: string | null
  connections: Record<string, ModelConnection>
  roles: ModelRoleView[]
  operations: Partial<Record<ModelRoleId, string[]>>
  // After a save or trust change: whether the change was written to the change history (rec#11 D-42).
  history?: 'recorded' | 'unchanged' | 'not_recorded'
}

// dimensions: the length of 语义搜索's vectors, on its check only.
export interface ModelRoleCheckResult { ok: boolean; receipt: { status: string; reason?: string | null; actualModel?: string | null }; dimensions?: number | null }
export const checkModelRole = (role: ModelRoleId) => postJson<ModelRoleCheckResult>(`/api/model-backends/roles/${role}/check`, {})

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
  headers: string
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

// A new role has no limit until the person sets one, and no project approved
// for the model API's egress.
const NEW_ROLE_BUDGET: ModelBudget = {
  maxInputTokens: null, maxOutputTokens: null, timeoutMs: null, windowHours: null, maxTokensPerWindow: null, maxCostPerWindow: null,
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
  const semantic = role === SEMANTIC_ROLE
  return {
    ...connectionFields(payload.connections[connectionId] ?? (semantic ? { ...NEW_CONNECTION, protocol: EMBEDDING_PROTOCOL } : NEW_CONNECTION)),
    enabled: view?.state === 'enabled',
    connectionId,
    // Dreaming sends sessions to the model, so a new role starts without it: the person turns it on.
    operations: (view?.allowedOperations ?? (payload.operations[role] ?? []).filter(operation => operation !== 'dreaming')).join(', '),
    approvedProjects: [...(view?.egress?.approvedProjects ?? [])],
    allowUnassigned: view?.egress?.allowUnassigned ?? false,
    maxInputTokens: text(budget.maxInputTokens),
    maxOutputTokens: text(budget.maxOutputTokens),
    timeoutSeconds: text(budget.timeoutMs === null ? null : budget.timeoutMs / 1000),
    windowHours: text(budget.windowHours),
    maxTokensPerWindow: text(budget.maxTokensPerWindow),
    maxCostPerWindow: text(budget.maxCostPerWindow),
    // A session cannot turn text into vectors, so 语义搜索 never falls back to one.
    fallbackToSession: !semantic && (view?.fallbackToSession ?? true),
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
    headers: Object.entries(connection.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n'),
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
      ...headerFields(draft.headers),
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
  const code = apiErrorCode(cause)
  return code === 'model_config_changed' || code === 'model_config_invalid' ? code : null
}

// One `Name: value` per line, as the field shows them.
function headerFields(text: string) {
  const headers = Object.fromEntries(text.split('\n').flatMap((line) => {
    const colon = line.indexOf(':')
    return colon > 0 ? [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]] : []
  }))
  return Object.keys(headers).length ? { headers } : {}
}

export const saveModelRole = (role: ModelRoleId, draft: RoleDraft, revision: string | null) =>
  putJson<ModelRolesPayload>(`/api/model-backends/roles/${role}`, roleEdit(draft, revision))

// ---- Keys -----------------------------------------------------------------
// Saved on this computer by src/model-backends/keys-http.js. The key goes out
// once in a request body; the page only ever learns which references have one.

// The pattern src/model-backends/secret-store.js accepts for a reference.
const KEY_REFERENCE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function validKeyReference(reference: string): boolean {
  return KEY_REFERENCE.test(reference.trim())
}

/** Every key name this computer already knows: saved keys and those connections name. */
export function knownKeyReferences(payload: ModelRolesPayload, saved: readonly string[]) {
  const named = Object.values(payload.connections).flatMap(connection => connection.secretRef ?? [])
  return [...new Set([...saved, ...named])].sort((left, right) => left.localeCompare(right))
}

export const readSavedKeys = () => getJson<{ saved: string[] }>('/api/model-backends/keys')
export const saveModelKey = (reference: string, key: string) =>
  putJson<{ reference: string; saved: true }>(`/api/model-backends/keys/${encodeURIComponent(reference.trim())}`, { key })

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
  // requests are calls and failedRequests the calls no attempt answered;
  // attempts count every try, retries included.
  requests: number
  failedRequests: number
  attempts: number
  failedAttempts: number
  // Attempts that returned no token counts at all, and how many of them failed.
  unreportedAttempts: number
  unreportedFailedAttempts: number
  tokens: Partial<Record<'input' | 'output' | 'total' | 'cachedInput' | 'cacheWriteInput' | 'reasoning', TokenCell>>
}

export interface UsagePayload { groups: UsageGroup[] }

export const readModelUsage = (window: UsageWindow, signal?: AbortSignal) =>
  getJson<UsagePayload>(`/api/model-backends/usage?from=${encodeURIComponent(usageWindowStart(window))}`, { signal })

// What a usage cell says: a known value, a known part with the attempts that
// returned nothing for this cell alone, or nothing returned at all. Attempts
// that returned no usage at all are said once for the row (usageRowNote), so
// they are taken out of each cell's own count.
export type UsageValue =
  | { kind: 'known'; value: number }
  | { kind: 'partial'; value: number; unknown: number }
  | { kind: 'unknown' }

export function tokenValue(cell: TokenCell | undefined, unreportedAttempts = 0): UsageValue {
  if (!cell || cell.reported === null) return { kind: 'unknown' }
  const unknown = Math.max(0, cell.unknownAttempts - unreportedAttempts)
  return unknown ? { kind: 'partial', value: cell.reported, unknown } : { kind: 'known', value: cell.reported }
}

// The one note for a row whose numbers leave out attempts that returned no
// usage; empty when nothing was left out or nothing came back at all.
export function usageRowNote(group: UsageGroup, locale: string): string {
  const count = group.unreportedAttempts
  if (!count || count >= group.attempts) return ''
  const key = count === group.unreportedFailedAttempts ? 'unreportedFailed' : 'unreported'
  return t(`modelSettings.usage.${key}`, { count: formatCount(count, locale) })
}

// The token cells of a row, each in words. Cache cells appear only when the
// provider returned them at all; the row note's tries leave each cell's count.
const TOKEN_CELLS = [['input', 'input'], ['output', 'output'], ['cache', 'cachedInput'], ['cacheWrite', 'cacheWriteInput']] as const
const OPTIONAL_FIELDS = new Set<string>(['cachedInput', 'cacheWriteInput'])

export function usageCells(group: UsageGroup, locale: string): { key: typeof TOKEN_CELLS[number][0]; value: string; note: string }[] {
  const leftOut = usageRowNote(group, locale) ? group.unreportedAttempts : 0
  return TOKEN_CELLS.filter(([, field]) => !OPTIONAL_FIELDS.has(field) || group.tokens[field])
    .map(([key, field]) => ({ key, ...usageParts(tokenValue(group.tokens[field], leftOut), locale) }))
}

// Calls in plain words: how many, how many failed in the end, and the tries
// they took when retries added more.
export function callParts(group: UsageGroup, locale: string): { value: string; failed: string; note: string } {
  return {
    value: t('modelSettings.usage.callsValue', { calls: formatCount(group.requests, locale) }),
    failed: group.failedRequests ? t('modelSettings.usage.failed', { count: formatCount(group.failedRequests, locale) }) : '',
    note: group.attempts > group.requests ? t('modelSettings.usage.tries', { count: formatCount(group.attempts, locale) }) : '',
  }
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
      key: [group.role, group.channel, group.provider, group.model].join('|'),
      group,
      share: group.tokens.total?.reported === null || group.tokens.total?.reported === undefined || !largest
        ? null : group.tokens.total.reported / largest,
    }))
  }
  return { model: rows('model_api'), session: rows('session') }
}

// One usage cell in words: 没返回 when nothing came back, never 0. A partly
// returned value keeps its note apart, so the note wraps as a whole instead
// of breaking inside a word.
export function usageParts(value: UsageValue, locale: string): { value: string; note: string } {
  if (value.kind === 'unknown') return { value: t('modelSettings.usage.notReturned'), note: '' }
  const note = value.kind === 'partial' ? t('modelSettings.usage.partialNote', { count: formatCount(value.unknown, locale) }) : ''
  return { value: formatCount(value.value, locale), note }
}

export const formatCount = (value: number, locale: string) => new Intl.NumberFormat(locale).format(value)

// The website's model guide (site/models): what each model does, what is enough
// and what it cost when we measured, in the console's language.
export const modelGuideUrl = (locale: string) => websitePageUrl('models', locale)

