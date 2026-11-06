import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// A finished task's retrospective (roadmap issue 346): what Astro's model wrote after
// FLAs finished it. Its lessons wait in the person's review queue.
const lesson = z.looseObject({ title: z.string(), status: z.string() })
const retrospective = z.looseObject({ at: z.string(), status: z.string(), summary: z.string().nullable(),
  problems: z.array(z.string()), lessons: z.array(lesson), wordsRemoved: z.boolean() })
const readShape = shapeOf(z.looseObject({ retrospective: retrospective.nullable() }))

export type TaskRetrospective = z.infer<typeof retrospective>
export const readRetrospective = (taskId: string) =>
  getJson(`/api/retrospectives?${new URLSearchParams({ taskId })}`, readShape).then(read => read.retrospective)

/** Only a written one is shown; a failed attempt is retried by FULI and says nothing here. */
export const shownRetrospective = (value: TaskRetrospective | null) => (value?.status === 'written' ? value : null)
/** Lessons still in the review queue, for the one 去确认 link. */
export const queuedLessons = (value: TaskRetrospective) => value.lessons.filter(lesson => lesson.status === 'queued').length
