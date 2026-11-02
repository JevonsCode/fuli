import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PARALLAX_SHIFT, startBackdropParallax } from './backdrop-parallax'

const move = (pointerType: string, clientX: number, clientY: number) => {
  const event = new MouseEvent('pointermove', { clientX, clientY }) as PointerEvent
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  window.dispatchEvent(event)
}
const lean = (stage: HTMLElement) => ({
  x: Number(stage.style.getPropertyValue('--parallax-x') || 0),
  y: Number(stage.style.getPropertyValue('--parallax-y') || 0),
})

describe('the backdrop parallax', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    Object.assign(window, { innerWidth: 1000, innerHeight: 800 })
  })
  afterEach(() => { vi.useRealTimers() })

  it('leans away from a moving mouse by a few pixels, gliding, and requests no frame once at rest', () => {
    const stage = document.createElement('div')
    const stop = startBackdropParallax(stage, () => false)
    move('mouse', 1000, 0)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersToNextFrame()
    const first = lean(stage)
    expect(first.x).toBeLessThan(0)
    expect(first.x).toBeGreaterThan(-PARALLAX_SHIFT / 2)
    expect(first.y).toBeGreaterThan(0)

    vi.advanceTimersByTime(5_000)
    expect(lean(stage)).toEqual({ x: -PARALLAX_SHIFT, y: PARALLAX_SHIFT })
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('never moves for touch or pen', () => {
    const stage = document.createElement('div')
    const stop = startBackdropParallax(stage, () => false)
    move('touch', 1000, 0)
    move('pen', 0, 800)
    expect(vi.getTimerCount()).toBe(0)
    expect(lean(stage)).toEqual({ x: 0, y: 0 })
    stop()
  })

  it('stays centred while motion is reduced and settles at once when it becomes reduced', () => {
    const stage = document.createElement('div')
    let reduced = true
    const stop = startBackdropParallax(stage, () => reduced)
    move('mouse', 1000, 0)
    expect(vi.getTimerCount()).toBe(0)

    reduced = false
    move('mouse', 1000, 0)
    vi.advanceTimersByTime(200)
    expect(lean(stage).x).toBeLessThan(0)

    reduced = true
    move('mouse', 0, 0)
    expect(lean(stage)).toEqual({ x: 0, y: 0 })
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('glides back to the centre when the pointer leaves the window', () => {
    const stage = document.createElement('div')
    const stop = startBackdropParallax(stage, () => false)
    move('mouse', 0, 0)
    vi.advanceTimersByTime(5_000)
    expect(lean(stage).x).toBe(PARALLAX_SHIFT)

    document.documentElement.dispatchEvent(new Event('pointerleave'))
    vi.advanceTimersByTime(5_000)
    expect(lean(stage)).toEqual({ x: 0, y: 0 })
    stop()
  })

  it('removes its listeners and pending frame when stopped', () => {
    const stage = document.createElement('div')
    const stop = startBackdropParallax(stage, () => false)
    move('mouse', 1000, 0)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    move('mouse', 0, 0)
    expect(vi.getTimerCount()).toBe(0)
    expect(stage.style.getPropertyValue('--parallax-x')).toBe('')
  })
})
