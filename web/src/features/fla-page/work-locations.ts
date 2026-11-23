import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'

// Where one FLA worked: which clients, which models, how many segments of work
// each (rec issue 147). The server counts the conversation session records
// FULI already keeps, and says how far the count reaches: scopes it could not
// read and every way the count was cut short
// (GET /api/project-agent-work-locations, src/graphiti/agent-work-locations.js).
//
// Nothing here renders a value FULI was not given: an unreported one shows as
// UNREPORTED with its reason, never as 0 or a default model name.
export const UNREPORTED = '-'

const modelSource = z.enum(['actual', 'requested', 'unknown'])
const segmentSchema = z.looseObject({
  conversation_id: z.string().nullable(),
  personal_project_id: z.string().nullable(),
  client: z.string().nullable(),
  session_id: z.string().nullable(),
  session_short: z.string().nullable(),
  when: z.string().nullable(),
  status: z.string().nullable(),
  title: z.string().optional(),
  // true: this computer's own hook saw the session; null: FULI cannot tell.
  on_this_computer: z.boolean().nullable().optional(),
})
const rowSchema = z.looseObject({
  client: z.string().nullable(),
  model: z.string().nullable(),
  model_source: modelSource,
  model_reason: z.string().optional(),
  segments: z.number(),
  conversations: z.number(),
  last_seen: z.string().nullable(),
  recent: z.array(segmentSchema),
  recent_more: z.number().optional(),
})
const gapSchema = z.looseObject({ reason: z.string(), personal_project_id: z.string().nullable().optional(),
  scope: z.string().optional(), read: z.number().optional(), total: z.number().optional() })
// Continuing this work elsewhere is its own field, never mixed into a segment:
// it opens a NEW session and leaves the original conversation where it is.
const continuationSchema = z.looseObject({
  conversation_id: z.string(),
  personal_project_id: z.string().nullable(),
  title: z.string().optional(),
  prompt: z.string(),
  opens: z.literal('new_session'),
  leaves_original: z.boolean(),
})
const workLocationsSchema = z.looseObject({
  rows: z.array(rowSchema),
  segments: z.number(),
  conversations_read: z.number(),
  complete: z.boolean(),
  unavailable: z.array(gapSchema).optional(),
  truncated: z.array(gapSchema).optional(),
  continuation: continuationSchema.nullable(),
})
const workLocationsShape = shapeOf(workLocationsSchema)

export type WorkRow = z.infer<typeof rowSchema>
export type WorkSegment = z.infer<typeof segmentSchema>
export type WorkGap = z.infer<typeof gapSchema>
export type WorkLocations = z.infer<typeof workLocationsSchema>
export type WorkLocationsState = 'loading' | 'ready' | 'failed'

export function readWorkLocations(personalSpaceId: string, agentId: string, signal?: AbortSignal): Promise<WorkLocations> {
  return getJson(`/api/project-agent-work-locations?${new URLSearchParams({ personalSpaceId, agentId })}`,
    workLocationsShape, { signal })
}

// One read per FLA, shared by every widget that shows it (the count and the
// continue-elsewhere card): the read stops when the last one goes away.
interface Source { value: Ref<WorkLocations | null>, state: Ref<WorkLocationsState>, users: number, stop: () => void }
const sources = new Map<string, Source>()
const keyOf = (spaceId: string, agentId: string) => `${spaceId}\u0000${agentId}`

function open(spaceId: string, agentId: string): Source {
  const key = keyOf(spaceId, agentId)
  const existing = sources.get(key)
  if (existing) { existing.users += 1; return existing }
  const scope = effectScope(true)
  const controller = new AbortController()
  const source = scope.run(() => {
    const value = ref<WorkLocations | null>(null)
    const state = ref<WorkLocationsState>('loading')
    readWorkLocations(spaceId, agentId, controller.signal)
      .then((result) => { value.value = result; state.value = 'ready' })
      .catch(() => { if (!controller.signal.aborted) state.value = 'failed' })
    return { value, state }
  })!
  const opened: Source = { ...source, users: 1, stop: () => { controller.abort(); scope.stop() } }
  sources.set(key, opened)
  return opened
}

function close(spaceId: string, agentId: string) {
  const key = keyOf(spaceId, agentId)
  const source = sources.get(key)
  if (!source) return
  source.users -= 1
  if (source.users > 0) return
  source.stop()
  sources.delete(key)
}

export function useWorkLocations(spaceId: Ref<string>, agentId: Ref<string>) {
  const current = shallowRef<Source | null>(null)
  let opened: [string, string] | null = null
  watch(() => [spaceId.value, agentId.value] as const, ([space, agent]) => {
    if (opened) close(...opened)
    opened = space && agent ? [space, agent] : null
    current.value = opened ? open(...opened) : null
  }, { immediate: true })
  onScopeDispose(() => { if (opened) close(...opened) })
  return {
    located: computed(() => current.value?.value.value ?? null),
    state: computed<WorkLocationsState>(() => current.value?.state.value ?? 'loading'),
  }
}

/** Tests start from no shared reads. */
export function forgetWorkLocations() {
  for (const source of sources.values()) source.stop()
  sources.clear()
}

/** The model column: the model as recorded, or UNREPORTED. */
export function modelText(row: { model: string | null }): string {
  return row.model ?? UNREPORTED
}

/**
 * The note beside the model column, in the interface language: why a model is
 * unknown, or that a named one is only what the client asked for.
 */
export function modelNote(row: { model: string | null, model_source: string, model_reason?: string }): string {
  if (row.model && row.model_source === 'requested') return t('flaPage.worked.requested')
  if (row.model_reason === 'not_read') return t('flaPage.worked.modelNotRead')
  if (row.model_reason === 'not_recorded') return t('flaPage.worked.modelNotRecorded')
  if (row.model_reason === 'client_not_recorded') return t('flaPage.worked.clientNotRecorded')
  return ''
}

/** One gap in the count, in the interface language. */
export function gapText(gap: WorkGap, projectName: (id: string) => string): string {
  const project = gap.personal_project_id ? projectName(gap.personal_project_id) : t('flaPage.worked.global')
  switch (gap.reason) {
    case 'conversations_limit': return t('flaPage.worked.gap.conversations', { project, count: gap.read ?? 0 })
    case 'sessions_per_conversation': return t('flaPage.worked.gap.sessions', { count: gap.read ?? 0 })
    case 'projects_limit': return t('flaPage.worked.gap.projects', { read: gap.read ?? 0, total: gap.total ?? 0 })
    case 'global_scope_not_counted': return t('flaPage.worked.gap.global')
    default: return gap.scope === 'assignments'
      ? t('flaPage.worked.gap.assignments')
      : t('flaPage.worked.gap.unreadable', { project })
  }
}

export function whenText(value: string | null): string {
  return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    { missing: UNREPORTED })
}
