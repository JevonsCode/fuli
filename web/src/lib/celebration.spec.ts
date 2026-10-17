import { afterEach, describe, expect, it, vi } from 'vitest'

describe('celebrateOnce', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); document.documentElement.removeAttribute('data-motion') })

  it('bursts once per key and never twice for the same completion', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, globalAlpha: 1, fillStyle: '',
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    const { celebrateOnce } = await import('./celebration')
    const anchor = document.createElement('div')
    expect(celebrateOnce('task-1', anchor)).toBe(true)
    expect(document.querySelector('[data-celebration]')).not.toBeNull()
    expect(celebrateOnce('task-1', anchor)).toBe(false)
  })

  it('stays still when motion is reduced', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    const { setMotionPreference } = await import('./motion-preference')
    setMotionPreference('reduced')
    const { celebrateOnce } = await import('./celebration')
    expect(celebrateOnce('task-2', document.createElement('div'))).toBe(false)
    expect(getContext).not.toHaveBeenCalled()
    expect(document.querySelector('[data-celebration]')).toBeNull()
    setMotionPreference('system')
  })
})
