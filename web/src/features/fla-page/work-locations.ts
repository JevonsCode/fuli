import { computed, type Ref } from 'vue'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { sharedRead } from '@/lib/shared-read'

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

export function readWorkLocations(personalSpaceId: string, agentId: string, signal?: AbortSignal): Promise<WorkLocations> {
  return getJson(`/api/project-agent-work-locations?${new URLSearchParams({ personalSpaceId, agentId })}`,
    workLocationsShape, { signal })
}

// One read per FLA, shared by every piece that shows it (the count on the
// page and the continuation in the hand-off panel).
const locations = sharedRead((key, signal) => readWorkLocations(key[0]!, key[1]!, signal))

export function useWorkLocations(spaceId: Ref<string>, agentId: Ref<string>) {
  const { value, state } = locations.use(computed(() => [spaceId.value, agentId.value]))
  return { located: value, state }
}

/** Tests start from no shared reads. */
export const forgetWorkLocations = locations.forget

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
