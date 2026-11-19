import { getActivePinia } from 'pinia'
import { reactive } from 'vue'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { useConsoleStore } from '@/stores/console'

// Which client made a session temporary project, where the session records FULI
// kept derive its exact ID (GET /api/personal-projects/temporary-sources). Read each
// time a picker shows temporary projects themselves (a folded row reads nothing),
// never with the console state. Each answer is the whole truth for its space: a
// project it leaves out loses a source shown before. An answer to an earlier
// question, or for a space no longer active, is dropped.
export interface TemporaryProjectSource { client: string }

const sourcesShape = shapeOf(z.array(z.looseObject({
  personal_project_id: z.string(), source_application: z.string(),
})))

const known = reactive(new Map<string, Map<string, TemporaryProjectSource>>())
// The latest question per space; an answer to an earlier one is stale.
const latest = new Map<string, number>()
let questions = 0

// Without the console store (an isolated component) there is no active space to ask about.
const activeSpace = () => (getActivePinia() ? useConsoleStore().state?.activePersonalSpaceId ?? null : null)

/** The proven source of one temporary project of the active space, if one was read. */
export function temporaryProjectSource(spaceId: string, projectId: string) {
  return spaceId === activeSpace() ? known.get(spaceId)?.get(projectId) : undefined
}

/**
 * Call when a picker shows temporary projects themselves (opened, or listed by a
 * search): asks which session made the active space's temporary projects. The
 * newest answer replaces the last. A folded row showing a heading and a count asks nothing.
 */
export function readTemporaryProjectSources() {
  const spaceId = activeSpace()
  if (!spaceId) return
  const question = ++questions
  latest.set(spaceId, question)
  getJson(`/api/personal-projects/temporary-sources?${new URLSearchParams({ personalSpaceId: spaceId })}`, sourcesShape)
    .then((rows) => {
      if (latest.get(spaceId) !== question || spaceId !== activeSpace()) return
      known.set(spaceId, new Map(rows.map(row => [row.personal_project_id, { client: row.source_application }])))
    })
    // A failed read changes nothing shown; the next time temporary projects are shown it asks again.
    .catch(() => {})
}
