import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POINTER_INTENT_MS, pointInBox, usePointerPresence } from './usePointerPresence'

const move = (clientX: number) => document.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY: 0 }))

describe('usePointerPresence', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function setup() {
    const active = ref(true)
    const leave = vi.fn()
    const scope = effectScope()
    scope.run(() => usePointerPresence({ active, inside: event => event.clientX < 100, leave }))
    return { active, leave, scope }
  }

  it('calls leave once the pointer has stayed outside for the intent delay', () => {
    const { leave } = setup()
    move(500)
    vi.advanceTimersByTime(POINTER_INTENT_MS - 1)
    move(600)
    expect(leave).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('forgets the leave when the pointer comes back in time', () => {
    const { leave } = setup()
    move(500)
    vi.advanceTimersByTime(POINTER_INTENT_MS - 1)
    move(50)
    vi.advanceTimersByTime(POINTER_INTENT_MS)
    expect(leave).not.toHaveBeenCalled()
  })

  it('treats the pointer leaving the window as leaving', () => {
    const { leave } = setup()
    document.dispatchEvent(new MouseEvent('pointerout', { relatedTarget: null }))
    vi.advanceTimersByTime(POINTER_INTENT_MS)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('stops watching while inactive and when its scope ends', async () => {
    const { active, leave, scope } = setup()
    active.value = false
    await nextTick()
    move(500)
    vi.advanceTimersByTime(POINTER_INTENT_MS)
    expect(leave).not.toHaveBeenCalled()
    active.value = true
    await nextTick()
    scope.stop()
    move(500)
    vi.advanceTimersByTime(POINTER_INTENT_MS)
    expect(leave).not.toHaveBeenCalled()
  })

  it('counts a margin around a box as inside it', () => {
    const box = new DOMRect(10, 10, 20, 20)
    expect(pointInBox(5, 5, box, 14)).toBe(true)
    expect(pointInBox(5, 5, box)).toBe(false)
    expect(pointInBox(5, 5, null, 14)).toBe(false)
  })
})
