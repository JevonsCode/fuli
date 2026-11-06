import { z } from 'zod'
import { getJson, patchJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'
import { verificationSchema } from '@/features/verification/verification'

// rec#78 slice 1: what an FLA learned by doing. The server lists its reusable
// experiences, proven-first (used in more tasks); the person keeps one
// (confirm) or drops it (mark_outdated: it leaves current answers and keeps
// its history). Nothing here promotes an experience on its own.
const basisSchema = z.looseObject({
  existence_reason: z.string().nullish(),
  quadrant_reason: z.string().nullish(),
  proposed_by: z.looseObject({ kind: z.string(), label: z.string().nullish() }).nullish(),
})
const itemSchema = z.looseObject({
  itemId: z.string(),
  personalProjectId: z.string(),
  title: z.string(),
  solution: z.string(),
  boundary: z.string().nullable(),
  status: z.string(),
  uses: z.number(),
  tasks: z.number(),
  lastUsedAt: z.string().nullable(),
  /** Used in enough tasks to be judged first (the server decides). */
  proven: z.boolean(),
  basis: basisSchema.nullable(),
  /** Absent from a server older than the verification states. */
  verification: verificationSchema.optional(),
})
const growthSchema = z.looseObject({
  partial: z.boolean(),
  counts: z.looseObject({ total: z.number(), proven: z.number(), kept: z.number() }),
  items: z.array(itemSchema),
})
const growthShape = shapeOf(growthSchema)

export type GrowthItem = z.infer<typeof itemSchema>
export type AgentGrowth = z.infer<typeof growthSchema>

export const readAgentGrowth = (personalSpaceId: string, agentId: string, signal?: AbortSignal) =>
  getJson(`/api/project-agents/${encodeURIComponent(agentId)}/growth?${new URLSearchParams({ personalSpaceId })}`, growthShape, { signal })

const itemPath = (item: GrowthItem) => `/api/knowledge/entity/${encodeURIComponent(item.itemId)}`

/** 保留: the person's click is the confirmation, on the reasons the FLA recorded. */
export const keepExperience = (personalSpaceId: string, item: GrowthItem) => patchJson(itemPath(item), {
  personalSpaceId,
  personalProjectId: item.personalProjectId,
  action: 'confirm',
  reason: t('flaPage.growth.keepReason'),
  confirmationStatus: 'confirmed',
  confirmationBasis: {
    existenceReason: item.basis?.existence_reason || t('flaPage.growth.keepReason'),
    quadrantReason: item.basis?.quadrant_reason || t('flaPage.growth.keepReason'),
    proposedBy: item.basis?.proposed_by ?? { kind: 'agent', label: null },
    confirmedBy: { kind: 'user', label: t('knowledge.domain.actors.currentUser') },
    confirmedAt: new Date().toISOString(),
  },
})

/** 不要: ends it as the person's negative feedback; its history stays. */
export const dropExperience = (personalSpaceId: string, item: GrowthItem) => patchJson(itemPath(item), {
  personalSpaceId,
  personalProjectId: item.personalProjectId,
  action: 'mark_outdated',
  reason: t('flaPage.growth.dropReason'),
})
