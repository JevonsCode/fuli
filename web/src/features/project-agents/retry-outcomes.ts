import { reactive } from 'vue'
import type { RetryResponse } from './task-runs'

// A retry's result outlives the task panel that made it: a successful retry
// refreshes the Agent's details, which redraws the panel. The result, with any
// notice that must be shown, stays in memory for this page session only.
const outcomes = reactive(new Map<string, RetryResponse>())
const key = (spaceId: string, taskId: string) => `${spaceId}\u0000${taskId}`

export const retryOutcome = (spaceId: string, taskId: string) => outcomes.get(key(spaceId, taskId)) ?? null
export function keepRetryOutcome(spaceId: string, taskId: string, outcome: RetryResponse) { outcomes.set(key(spaceId, taskId), outcome) }
export function forgetRetryOutcome(spaceId: string, taskId: string) { outcomes.delete(key(spaceId, taskId)) }
