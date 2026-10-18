import { motionReduced } from './motion-preference'

// A short, bounded burst for a real completion. One at a time, never on a
// hidden page, and never when motion is reduced; failures stay silent.
const PARTICLES = 22
const DURATION_MS = 900
const celebrated = new Set<string>()
let running = false

// A key is only spent by a burst that actually started; a skipped one
// (another playing, hidden page, no anchor) leaves a later chance. The colour
// is a token name, read from the anchor so it follows the active palette.
export function celebrateOnce(key: string, anchor: HTMLElement | null, colorToken = '--color-accent') {
  if (celebrated.has(key)) return false
  const started = burst(anchor, colorToken)
  if (started) celebrated.add(key)
  return started
}

function burst(anchor: HTMLElement | null, colorToken: string) {
  if (!anchor || running || motionReduced() || document.hidden) return false
  const color = getComputedStyle(anchor).getPropertyValue(colorToken).trim()
  const rect = anchor.getBoundingClientRect()
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return false
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(rect.width, 160)
  const height = 120
  canvas.width = width * ratio
  canvas.height = height * ratio
  Object.assign(canvas.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top - height / 2}px`,
    width: `${width}px`, height: `${height}px`, pointerEvents: 'none', zIndex: '40',
  })
  canvas.setAttribute('aria-hidden', 'true')
  canvas.dataset.celebration = ''
  document.body.append(canvas)
  context.scale(ratio, ratio)
  const particles = Array.from({ length: PARTICLES }, (_, index) => {
    const angle = (Math.PI * 2 * index) / PARTICLES
    const speed = 1.6 + (index % 5) * 0.35
    return { x: width / 2, y: height / 2, dx: Math.cos(angle) * speed, dy: Math.sin(angle) * speed - 1.2 }
  })
  running = true
  const start = performance.now()
  const frame = (now: number) => {
    const progress = (now - start) / DURATION_MS
    context.clearRect(0, 0, width, height)
    if (progress >= 1 || document.hidden) {
      canvas.remove()
      running = false
      return
    }
    context.globalAlpha = 1 - progress
    if (color) context.fillStyle = color
    for (const particle of particles) {
      particle.x += particle.dx
      particle.y += particle.dy
      particle.dy += 0.06
      context.beginPath()
      context.arc(particle.x, particle.y, 2.4, 0, Math.PI * 2)
      context.fill()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  return true
}
