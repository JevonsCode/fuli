import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOTION_STORAGE_KEY,
  initMotionPreference,
  motionPreference,
  motionReduced,
  setMotionPreference,
} from './motion-preference'

const systemReduce = (matches: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
  matches: matches && query === '(prefers-reduced-motion: reduce)', media: query,
})))

describe('motion preference', () => {
  afterEach(() => {
    setMotionPreference('system')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('restores a stored choice onto the document at start-up', () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, 'reduced')
    initMotionPreference()
    expect(motionPreference.value).toBe('reduced')
    expect(document.documentElement.dataset.motion).toBe('reduced')
  })

  it('ignores unknown stored values and keeps following the system', () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, 'full')
    initMotionPreference()
    expect(motionPreference.value).toBe('system')
    expect(document.documentElement.dataset.motion).toBeUndefined()
  })

  it('still applies the choice to the page when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    setMotionPreference('reduced')
    expect(document.documentElement.dataset.motion).toBe('reduced')
    expect(motionReduced()).toBe(true)
  })

  it('never re-enables motion the system asked to reduce', () => {
    systemReduce(true)
    setMotionPreference('system')
    expect(motionReduced()).toBe(true)
    systemReduce(false)
    expect(motionReduced()).toBe(false)
    setMotionPreference('reduced')
    expect(motionReduced()).toBe(true)
  })
})
