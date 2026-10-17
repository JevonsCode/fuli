import { ref } from 'vue'

/** Per-browser convenience, like the interface language; never sent anywhere. */
export const MOTION_STORAGE_KEY = 'fuli.motion'

export type MotionPreference = 'system' | 'reduced'

export const motionPreference = ref<MotionPreference>('system')

function readStoredPreference(): MotionPreference {
  if (typeof window === 'undefined') return 'system'
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY) === 'reduced' ? 'reduced' : 'system'
  } catch {
    return 'system'
  }
}

function applyToDocument(value: MotionPreference) {
  if (typeof document === 'undefined') return
  // CSS mirrors every prefers-reduced-motion rule for this attribute.
  if (value === 'reduced') document.documentElement.dataset.motion = 'reduced'
  else delete document.documentElement.dataset.motion
}

export function initMotionPreference() {
  motionPreference.value = readStoredPreference()
  applyToDocument(motionPreference.value)
}

export function setMotionPreference(value: MotionPreference) {
  motionPreference.value = value
  applyToDocument(value)
  if (typeof window === 'undefined') return
  try {
    if (value === 'reduced') window.localStorage.setItem(MOTION_STORAGE_KEY, value)
    else window.localStorage.removeItem(MOTION_STORAGE_KEY)
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
}

/**
 * Whether decorative motion must stay off. The system setting always wins:
 * the in-app switch can only reduce motion, never re-enable it.
 */
export function motionReduced() {
  if (motionPreference.value === 'reduced') return true
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
