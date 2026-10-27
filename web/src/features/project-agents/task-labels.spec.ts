import { describe, expect, it } from 'vitest'
import { statusTone, taskStatusChipTone, taskStatusLabel, taskStatusTone } from './task-labels'

describe('statusTone', () => {
  it('gives one status one tone, and never a green or accent one to a problem', () => {
    for (const status of ['blocked', 'failed', 'unavailable']) {
      expect(statusTone(status)).toBe('danger')
      expect(taskStatusTone(status)).toBe('destructive')
      expect(taskStatusChipTone(status)).toBe('danger')
    }
    for (const status of ['awaiting_review', 'paused', 'awaiting_recruitment']) {
      expect(taskStatusChipTone(status)).toBe('warning')
    }
    expect(statusTone('running')).toBe('active')
    expect(statusTone('in_progress')).toBe('active')
    expect(taskStatusChipTone('running')).toBe('accent')
    expect(['completed', 'ended', 'cancelled'].map(taskStatusChipTone)).toEqual(['neutral', 'neutral', 'neutral'])
  })
})

describe('taskStatusTone', () => {
  it('reads trouble as danger, waiting as warning, live work as primary and done as success', () => {
    expect(taskStatusTone('blocked')).toBe('destructive')
    expect(taskStatusTone('failed')).toBe('destructive')
    expect(taskStatusTone('awaiting_review')).toBe('warning')
    expect(taskStatusTone('awaiting_recruitment')).toBe('warning')
    expect(taskStatusTone('running')).toBe('default')
    expect(taskStatusTone('completed')).toBe('success')
  })

  it('keeps queued, unknown and future statuses neutral', () => {
    expect(taskStatusTone('queued')).toBe('secondary')
    expect(taskStatusTone('something_new')).toBe('secondary')
  })
})

describe('taskStatusLabel', () => {
  it('reads every status from one table and names an unrecognized one only when asked', () => {
    expect(taskStatusLabel('running')).toBe('运行中')
    expect(taskStatusLabel('blocked')).toBe('阻塞')
    expect(taskStatusLabel('something_new')).toBe('something_new')
    expect(taskStatusLabel('something_new', { unrecognized: '状态未识别' })).toBe('状态未识别')
  })
})
