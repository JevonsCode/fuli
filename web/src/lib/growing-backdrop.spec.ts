import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backdropPose, GROW_PERIOD, GROW_STEP, poseTransform, startGrowingBackdrop } from './growing-backdrop'

const hidden = (value: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
const drift = { from: { x: 0, y: 1.5, scale: 1 }, to: { x: 1, y: -2, scale: 1.07 } }

describe('the growing backdrop', () => {
  beforeEach(() => { vi.useFakeTimers(); hidden(false) })
  afterEach(() => { vi.useRealTimers(); hidden(false) })

  it('drifts out over one period and back over the next, eased at both ends', () => {
    expect(backdropPose(drift, 0)).toEqual(drift.from)
    expect(backdropPose(drift, GROW_PERIOD)).toEqual(drift.to)
    expect(backdropPose(drift, 2 * GROW_PERIOD)).toEqual(backdropPose(drift, 0))
    expect(backdropPose(drift, GROW_PERIOD / 4).scale).toBeCloseTo(backdropPose(drift, GROW_PERIOD * 7 / 4).scale)
    // Eased: a step at the ends moves far less than one in the middle.
    const move = (at: number) => backdropPose(drift, at + GROW_STEP).scale - backdropPose(drift, at).scale
    expect(move(0)).toBeLessThan(move(GROW_PERIOD / 2 - GROW_STEP / 2) / 5)
  })

  it('steps on a timer, holds while hidden or reduced, and stops cleanly', () => {
    const element = document.createElement('div')
    let clock = GROW_PERIOD / 2
    let reduced = false
    const backdrop = startGrowingBackdrop(element, drift, () => reduced, () => clock)
    expect(element.style.transform).toBe(poseTransform(backdropPose(drift, GROW_PERIOD / 2)))

    clock += GROW_STEP
    vi.advanceTimersByTime(GROW_STEP)
    expect(element.style.transform).toBe(poseTransform(backdropPose(drift, GROW_PERIOD / 2 + GROW_STEP)))

    hidden(true)
    vi.advanceTimersByTime(GROW_STEP)
    expect(vi.getTimerCount()).toBe(0)
    hidden(false)
    clock += 10 * GROW_STEP
    document.dispatchEvent(new Event('visibilitychange'))
    expect(element.style.transform).toBe(poseTransform(backdropPose(drift, clock)))

    reduced = true
    vi.advanceTimersByTime(GROW_STEP)
    expect(element.style.transform).toBe(poseTransform(drift.from))
    expect(vi.getTimerCount()).toBe(0)

    reduced = false
    backdrop.resume()
    expect(vi.getTimerCount()).toBe(1)
    backdrop.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
