import { describe, expect, it } from 'vitest'
import { normalizeEvent, normalizeExecutionSummary, normalizeTask, normalizeWorkerRuntime } from './task-evidence'

describe('worker runtime evidence', () => {
  it.each(['projectScope', 'project_scope'])('preserves explicit temporary project scope from %s', (key) => {
    expect(normalizeTask({ task_id: 'task-a', [key]: { type: 'temporary', lifetime: 'task', persisted: true } })?.projectScope)
      .toEqual({ type: 'temporary', lifetime: 'task', persisted: true })
    expect(normalizeTask({ task_id: 'temporary-task', personal_project_id: 'temporary-project' })?.projectScope).toBeUndefined()
  })
  it.each([
    { application: 'claude_code', session_id: 'worker-session', session_url: null },
    { application: 'claude_code', sessionId: 'worker-session', sessionUrl: null },
  ])('preserves worker metadata beside host provenance', (workerRuntime) => {
    const entry = {
      event_id: 'event-a', task_id: 'task-a',
      source_application: 'codex', source_session_id: 'reporter-session',
      worker_runtime: workerRuntime,
    }
    for (const record of [normalizeEvent(entry), normalizeExecutionSummary([entry])?.[0]]) {
      expect(record?.workerRuntime).toEqual({
        application: 'claude_code', sessionId: 'worker-session', sessionUrl: null,
      })
      expect(record?.sourceApplication).toBe('codex')
      expect(record?.sourceSessionId).toBe('reporter-session')
      expect(record?.tokenUsage).toBeNull()
      expect(record?.actualModel).toBeNull()
    }
  })

  it.each([undefined, null, [], 'claude_code', { application: 'unknown' }])(
    'does not invent an executor for missing or invalid evidence (%j)', (value) => {
      expect(normalizeWorkerRuntime(value)).toBeNull()
    },
  )
})
