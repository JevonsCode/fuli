import { z } from 'zod'
import { postJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import type { HardDeleteKind, HardDeletePreview, HardDeleteResult } from './model'
import type { SourceDeletePreview, SourceDeleteSelection, SourceDeleteTarget } from './source-delete-model'

// The console's loopback routes of a permanent delete (rec#5 C9).

// What the dialog and the item page read of the Provider's preview and result
// (graph-provider/fuli_graph/knowledge_hard_delete_models.py,
// knowledge_source_delete_models.py). The unions stay with the interfaces in
// model.ts, so a kind or status is checked as text. The Provider writes every
// count and list it defaults; what it may leave null is nullish here.
const itemSchema = z.looseObject({
  item_kind: z.string(), item_id: z.string(), role: z.string(), title: z.string(), content: z.string(), status: z.string(),
})
const episodeSchema = z.looseObject({
  episode_id: z.string(), excerpt: z.string().nullish(), created_at: z.string().nullish(), other_items: z.number(),
  used_by: z.array(z.looseObject({ item_kind: z.string(), item_id: z.string(), title: z.string() })).nullish(),
})
const publicationSchema = z.looseObject({
  draft_id: z.string(), project_id: z.string(), project_name: z.string().nullish(), provider_url: z.string(), proposal_id: z.string(),
})
const draftsSchema = z.looseObject({
  pending: z.number().nullish(), submitted: z.number().nullish(), submitting: z.number().nullish(), unknown: z.number().nullish(),
})
const previewFields = {
  preview_id: z.string(), item_id: z.string(), title: z.string(), removed_episodes: z.array(episodeSchema),
  counts: z.record(z.string(), z.number()), publications: z.array(publicationSchema).nullish(), drafts: draftsSchema.nullish(),
}
const previewShape = shapeFor<HardDeletePreview>(z.looseObject({
  ...previewFields, item_kind: z.string(), items: z.array(itemSchema), kept_episodes: z.array(episodeSchema),
  dependents: z.array(z.looseObject({
    item_kind: z.string(), item_id: z.string(), title: z.string(), content: z.string(), direct: z.boolean(),
  })),
}))
const memoryScope = { agent_id: z.string(), agent_name: z.string().nullish(), project_name: z.string().nullish(),
  personal_project_id: z.string().nullish(), revisions: z.array(z.number()), current_revision: z.number() }
const sourceRowSchema = z.looseObject({
  key: z.string(), selected: z.boolean(), reason: z.string(), basis_changed: z.boolean(), source_count: z.number(),
  retained_source_count: z.number(), versions: z.array(itemSchema),
})
const sourcePreviewShape = shapeFor<SourceDeletePreview>(z.looseObject({
  ...previewFields, item_kind: z.string(), source_application: z.string().nullish(), fuli_session_id: z.string().nullish(),
  include: z.array(z.string()), exclude: z.array(z.string()), default_items: z.array(sourceRowSchema), affected_items: z.array(sourceRowSchema),
  agent_memory: z.looseObject({
    scrubbed: z.array(z.looseObject({ ...memoryScope, current: z.boolean() })),
    later: z.array(z.looseObject({ ...memoryScope, key: z.string(), from_revision: z.number(), selected: z.boolean() })),
  }).nullish(),
}))
// Only a complete or pending delete carries the deletion itself; an unknown, missing or refused one names the item.
const resultShape = shapeFor<HardDeleteResult>(z.looseObject({
  outcome: z.string(), item_kind: z.string(), item_id: z.string(), deletion_id: z.string().nullish(), deleted_at: z.string().nullish(),
  counts: z.record(z.string(), z.number()).nullish(), deleted_item_ids: z.array(z.string()).nullish(),
  local_stores: z.array(z.looseObject({
    store: z.string(), status: z.string(), changed: z.number().nullish(), reason: z.string().nullish(),
  })).nullish(),
}))

const path = (item: { item_kind: HardDeleteKind; item_id: string }) =>
  `/api/knowledge/${item.item_kind}/${encodeURIComponent(item.item_id)}/hard-delete`

export function previewHardDelete(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) {
  return postJson(`${path(item)}/preview`, { personalSpaceId: spaceId }, previewShape)
}

export function exportHardDelete(spaceId: string, preview: HardDeletePreview) {
  return postJson(`${path(preview)}/export`, { personalSpaceId: spaceId, previewId: preview.preview_id }, previewShape)
}

/** Where this item's delete stands; it settles a lost answer and finishes local cleanup, never deletes again. */
export function hardDeleteStatus(spaceId: string, item: { item_kind: HardDeleteKind; item_id: string }) {
  return postJson(`${path(item)}/status`, { personalSpaceId: spaceId }, resultShape)
}

function sourceBody(spaceId: string, target: SourceDeleteTarget, selection: SourceDeleteSelection) {
  return { personalSpaceId: spaceId, ...(target.item_kind === 'session'
    ? { sourceApplication: target.sourceApplication, sessionId: target.sessionId } : {}), ...selection }
}
export function previewSourceDelete(spaceId: string, target: SourceDeleteTarget, selection: SourceDeleteSelection) {
  return postJson(`${path(target)}/preview`, sourceBody(spaceId, target, selection), sourcePreviewShape)
}
export function confirmSourceDelete(spaceId: string, target: SourceDeleteTarget, preview: SourceDeletePreview, confirmation: string) {
  return postJson(path(target), { ...sourceBody(spaceId, target, { include: preview.include, exclude: preview.exclude }),
    previewId: preview.preview_id, confirmation: confirmation.trim() }, resultShape)
}

export function confirmHardDelete(spaceId: string, preview: HardDeletePreview, confirmation: string) {
  return postJson(path(preview), { personalSpaceId: spaceId, previewId: preview.preview_id,
    confirmation: confirmation.trim() }, resultShape)
}
