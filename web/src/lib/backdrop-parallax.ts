/**
 * The backdrop's pointer parallax: as a mouse moves, the backdrop's layers
 * lean a few pixels away from it, the deeper layers further, then glide to
 * rest. Only `--parallax-x` / `--parallax-y` on the stage change (the layers
 * turn them into a composited translate), at most once per frame and only
 * while there is still distance to cover; when the pointer is still, no frame
 * is requested. Touch and pen never move it, and reduced motion keeps it centred.
 */
/** The shift, in px, of the nearest layer with the pointer at a window edge. */
export const PARALLAX_SHIFT = 3
/** The share of the remaining distance covered each frame: a glide, not a snap. */
const GLIDE = 0.08
/** Closer than this, in px, the layers are at rest. */
const REST = 0.02

interface Offset { x: number; y: number }

export function startBackdropParallax(stage: HTMLElement, reduced: () => boolean) {
  const target: Offset = { x: 0, y: 0 }
  const current: Offset = { x: 0, y: 0 }
  let frame: number | undefined

  const paint = () => {
    stage.style.setProperty('--parallax-x', current.x.toFixed(2))
    stage.style.setProperty('--parallax-y', current.y.toFixed(2))
  }
  const step = () => {
    frame = undefined
    current.x += (target.x - current.x) * GLIDE
    current.y += (target.y - current.y) * GLIDE
    const resting = Math.abs(target.x - current.x) < REST && Math.abs(target.y - current.y) < REST
    if (resting) Object.assign(current, target)
    paint()
    if (!resting) frame = requestAnimationFrame(step)
  }
  const aim = (x: number, y: number) => {
    target.x = x
    target.y = y
    if (frame === undefined) frame = requestAnimationFrame(step)
  }
  const centre = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    Object.assign(target, { x: 0, y: 0 })
    Object.assign(current, target)
    paint()
  }

  // The choice of reduced motion is read on every move, so switching it (which
  // takes a click, so a move) settles the layers at once.
  const follow = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    if (reduced()) { if (current.x || current.y) centre(); return }
    aim(-(event.clientX / window.innerWidth - 0.5) * 2 * PARALLAX_SHIFT, -(event.clientY / window.innerHeight - 0.5) * 2 * PARALLAX_SHIFT)
  }
  // Leaving the window glides back to the centre.
  const leave = () => { if (!reduced()) aim(0, 0) }

  window.addEventListener('pointermove', follow, { passive: true })
  document.documentElement.addEventListener('pointerleave', leave)
  return function stop() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    window.removeEventListener('pointermove', follow)
    document.documentElement.removeEventListener('pointerleave', leave)
  }
}
