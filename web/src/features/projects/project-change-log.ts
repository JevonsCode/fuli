import { z } from 'zod'

import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { currentLocale, t } from '@/i18n'

// A project's change log (src/project-change-log/port.js): who changed which
// profile fields and when, newest first, as the server recorded them.
const FIELD_LABELS = {
  name: 'projectName',
  purpose: 'purpose',
  scope: 'scope',
  technical_summary: 'technicalSummary',
  boundaries: 'boundary',
  lifecycle: 'lifecycle',
  sources: 'sources',
} as const

type ChangedField = keyof typeof FIELD_LABELS

const actorSchema = z.looseObject({
  kind: z.enum(['person', 'agent', 'fuli']),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
})

const changeSchema = z.looseObject({
  field: z.enum(Object.keys(FIELD_LABELS) as [ChangedField, ...ChangedField[]]),
  before: z.string(),
  after: z.string(),
})

const entrySchema = z.looseObject({
  id: z.number(),
  at: z.string(),
  actor: actorSchema,
  changes: z.array(changeSchema),
})

const historyShape = shapeOf(z.looseObject({ entries: z.array(entrySchema), hasMore: z.boolean() }))

export type ProjectChangeActor = z.infer<typeof actorSchema>
export type ProjectChangeEntry = z.infer<typeof entrySchema>

export function readProjectChanges(personalSpaceId: string, projectId: string) {
  const query = new URLSearchParams({ personalSpaceId })
  return getJson(`/api/personal-projects/${encodeURIComponent(projectId)}/history?${query}`, historyShape)
}

export const changedFieldLabel = (field: ChangedField) => t(`projects.profileDialog.${FIELD_LABELS[field]}`)

/** The fields one change touched, as one list in the active language. */
export function changedFieldNames(entry: ProjectChangeEntry) {
  return new Intl.ListFormat(currentLocale(), { type: 'conjunction' })
    .format(entry.changes.map(({ field }) => changedFieldLabel(field)))
}

/** One side of a change as a person reads it: a lifecycle by its label, nothing as 空. */
export function changedValueText(field: ChangedField, value: string) {
  if (!value) return t('projects.overview.changeLog.empty')
  return field === 'lifecycle' ? t(`projects.profileDialog.lifecycles.${value}`) : value
}
