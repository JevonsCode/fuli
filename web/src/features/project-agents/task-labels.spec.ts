import { describe, expect, it } from 'vitest'
import { taskStatusTone } from './task-labels'

describe('taskStatusTone', () => {
  it('reads trouble as danger, waiting as warning, live work as primary and done as success', () => {
    expect(taskStatusTone('blocked')).toBe('destructive')
    expect(taskStatusTone('failed')).toBe('destructive')
    expect(taskStatusTone('awaiting_review')).toBe('warning')
    expect(taskStatusTone('waiting_for_human')).toBe('warning')
    expect(taskStatusTone('running')).toBe('default')
    expect(taskStatusTone('completed')).toBe('success')
  })

  it('keeps queued, unknown and future statuses neutral', () => {
    expect(taskStatusTone('queued')).toBe('secondary')
    expect(taskStatusTone('something_new')).toBe('secondary')
  })
})
