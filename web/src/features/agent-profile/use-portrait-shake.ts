import { motionReduced } from '@/lib/motion-preference'

// How long a portrait's playful click shake lasts before the class is removed.
const SHAKE_MS = 400

/**
 * A short playful shake for an FLA portrait's click (Jevons 11-02). The
 * wrapper and the dock's pins share it, so every FLA portrait answers the
 * same. The handler only toggles the CSS class (primitives.css) and never
 * prevents the click, so a portrait inside a link still follows it; reduced
 * motion skips the shake entirely.
 */
export function usePortraitShake() {
  function shake(event: MouseEvent) {
    if (motionReduced()) return
    const portrait = event.currentTarget
    if (!(portrait instanceof HTMLElement)) return
    portrait.classList.remove('agent-portrait-shake')
    // Restart the animation on a fast second click.
    void portrait.offsetWidth
    portrait.classList.add('agent-portrait-shake')
    window.setTimeout(() => portrait.classList.remove('agent-portrait-shake'), SHAKE_MS)
  }
  return { shake }
}
