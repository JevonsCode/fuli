import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// Where one FLA worked: which clients, which models, how many segments of work
// each (rec issue 147). The server counts the conversation session records FULI
// already keeps and says how far the count reaches
// (GET /api/project-agent-work-locations, src/graphiti/agent-work-locations.js).
//
// Nothing here renders a number FULI was not given: an unreported value shows
// as UNREPORTED with its reason, never as 0 or a default model name.
export const UNREPORTED = '-'

const modelSource = z.enum(['actual', 'requested', 'unknown'])
const modelReason = z.enum(['client_sends_none', 'not_recorded', 'client_not_recorded'])

const rowSchema = z.looseObject({
  client: z.string(),
  model: z.string().nullable(),
  model_source: modelSource,
  model_reason: modelReason.optional(),
  segments: z.number(),
  conversations: z.number(),
  last_seen: z.string().nullable(),
})
const segmentSchema = z.looseObject({
  conversation_id: z.string().nullable(),
  client: z.string(),
  session_id: z.string().nullable(),
  session_short: z.string().nullable(),
  model: z.string().nullable(),
  model_source: modelSource,
  model_reason: modelReason.optional(),
  when: z.string().nullable(),
  status: z.string().nullable(),
  branch: z.string().optional(),
  title: z.string().optional(),
})
// Continuing this work elsewhere is its own field, never mixed into a segment:
// it opens a NEW session and leaves the original conversation where it is.
const continuationSchema = z.looseObject({
  conversation_id: z.string(),
  prompt: z.string(),
  opens: z.literal('new_session'),
  leaves_original: z.boolean(),
})
const workLocationsSchema = z.looseObject({
  rows: z.array(rowSchema),
  segments: z.number(),
  conversations_read: z.number(),
  partial: z.boolean(),
  recent: z.array(segmentSchema),
  continuation: continuationSchema.nullable(),
})
const workLocationsShape = shapeOf(workLocationsSchema)

export type WorkRow = z.infer<typeof rowSchema>
export type WorkSegment = z.infer<typeof segmentSchema>
export type WorkLocations = z.infer<typeof workLocationsSchema>

export async function readWorkLocations(
  personalSpaceId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<WorkLocations> {
  const query = new URLSearchParams({ personalSpaceId, agentId })
  return getJson(`/api/project-agent-work-locations?${query}`, workLocationsShape, { signal })
}

/**
 * What to show in the model column. A model FULI holds is shown as it is; one
 * it does not is `-`, and `modelReasonText` says why in the interface language
 * rather than in a sentence the server composed.
 */
export function modelText(row: { model: string | null }): string {
  return row.model ?? UNREPORTED
}

export function modelReasonText(row: { model_reason?: string }, clientName: string): string {
  if (row.model_reason === 'client_sends_none') return t('flaPage.worked.clientSendsNoModel', { client: clientName })
  if (row.model_reason === 'not_recorded') return t('flaPage.worked.modelNotRecorded')
  if (row.model_reason === 'client_not_recorded') return t('flaPage.worked.clientNotRecorded')
  return ''
}

/** The model a `requested` row names answered nothing for certain; say so once. */
export function modelRequestedOnly(row: { model_source: string }): boolean {
  return row.model_source === 'requested'
}
