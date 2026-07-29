import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDebouncedAction } from './debounce'

afterEach(() => {
  vi.useRealTimers()
})

describe('createDebouncedAction', () => {
  it('runs once after activity has been quiet for the delay', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const action = createDebouncedAction(callback, 300)

    action.schedule()
    vi.advanceTimersByTime(200)
    action.schedule()
    vi.advanceTimersByTime(299)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('can flush or cancel a pending action', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const action = createDebouncedAction(callback, 300)

    action.schedule()
    action.flush()
    expect(callback).toHaveBeenCalledTimes(1)

    action.schedule()
    action.cancel()
    vi.advanceTimersByTime(300)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
