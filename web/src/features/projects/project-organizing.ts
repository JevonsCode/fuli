import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// 整理 (src/project-organizing/port.js): how well FULI knows a project and
// what the last runs of Astro's organising did. The console only reads it;
// a run is started by saying one sentence to the person's own AI.
const area = z.looseObject({ id: z.string(), zh: z.string(), en: z.string(), status: z.string(), note: z.string().optional() })
const run = z.looseObject({
  at: z.string(), model: z.string().nullable(), tier: z.string(), scope: z.string().optional(),
  added: z.number(), merged: z.number(), stale: z.number(), unsure: z.number(),
})
const state = z.looseObject({
  started: z.boolean(),
  areas: z.array(area),
  progress: z.looseObject({ settled: z.number(), total: z.number(), complete: z.boolean() }),
  runs: z.array(run),
})
const shape = shapeOf(state)

export type OrganizingArea = z.infer<typeof area>
export type OrganizingRun = z.infer<typeof run>
export type ProjectOrganizingState = z.infer<typeof state>

export const readProjectOrganizing = (spaceId: string, projectId: string, signal?: AbortSignal) =>
  getJson(`/api/project-organizing?${new URLSearchParams({ personalSpaceId: spaceId, personalProjectId: projectId })}`, shape, { signal })

// What the person says to their own AI to start a run. `#FLA Astro` hands the turn to Astro in any connected client.
export const ORGANIZE_SENTENCE = '#FLA Astro 整理当前项目'

export const runCounts = (value: OrganizingRun) =>
  t('projects.organizing.counts', { added: value.added, merged: value.merged, stale: value.stale, unsure: value.unsure })
