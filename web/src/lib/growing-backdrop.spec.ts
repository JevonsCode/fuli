import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backdropPose, GROW_PERIOD, GROW_STEP, poseTransform, startGrowingBackdrop } from './growing-backdrop'

const hidden = (value: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })

describe('the growing backdrop', () => {
  beforeEach(() => { vi.useFakeTimers(); hidden(false) })
  afterEach(() => { vi.useRealTimers(); hidden(false) })

  it('swells out over one period and back over the next, eased at both ends', () => {
    expect(backdropPose(0)).toEqual({ x: 0, y: 1.5, scale: 1 })
    expect(backdropPose(GROW_PERIOD)).toEqual({ x: 1, y: -2, scale: 1.07 })
    expect(backdropPose(2 * GROW_PERIOD)).toEqual(backdropPose(0))
    expect(backdropPose(GROW_PERIOD / 4).scale).toBeCloseTo(backdropPose(GROW_PERIOD * 7 / 4).scale)
    // Eased: a step at the ends moves far less than one in the middle.
    const move = (at: number) => backdropPose(at + GROW_STEP).scale - backdropPose(at).scale
    expect(move(0)).toBeLessThan(move(GROW_PERIOD / 2 - GROW_STEP / 2) / 5)
  })

  it('moves under two pixels per step on a 1920×1080 screen, too little to see on a soft glow', () => {
    // Translate percentages are of the layer, which overhangs the screen by 8% on every side.
    const width = 1.16 * 1920, height = 1.16 * 1080
    let largest = 0
    for (let at = 0; at < GROW_PERIOD; at += GROW_STEP) {
      const [a, b] = [backdropPose(at), backdropPose(at + GROW_STEP)]
      largest = Math.max(largest, Math.abs(b.x - a.x) / 100 * width, Math.abs(b.y - a.y) / 100 * height)
    }
    expect(largest).toBeLessThan(2)
  })

  it('steps on a timer, holds while hidden or reduced, and stops cleanly', () => {
    const element = document.createElement('div')
    let clock = GROW_PERIOD / 2
    let reduced = false
    const backdrop = startGrowingBackdrop(element, () => reduced, () => clock)
    expect(element.style.transform).toBe(poseTransform(backdropPose(GROW_PERIOD / 2)))

    clock += GROW_STEP
    vi.advanceTimersByTime(GROW_STEP)
    expect(element.style.transform).toBe(poseTransform(backdropPose(GROW_PERIOD / 2 + GROW_STEP)))

    hidden(true)
    vi.advanceTimersByTime(GROW_STEP)
    expect(vi.getTimerCount()).toBe(0)
    hidden(false)
    clock += 10 * GROW_STEP
    document.dispatchEvent(new Event('visibilitychange'))
    expect(element.style.transform).toBe(poseTransform(backdropPose(clock)))

    reduced = true
    vi.advanceTimersByTime(GROW_STEP)
    expect(element.style.transform).toBe(poseTransform(backdropPose(0)))
    expect(vi.getTimerCount()).toBe(0)

    reduced = false
    backdrop.resume()
    expect(vi.getTimerCount()).toBe(1)
    backdrop.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
