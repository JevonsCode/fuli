/**
 * The growing backdrop (Jevons, 11-01: 有意思 as well as 有意义): a layer
 * drifts out and back along its motif's pose over a long, eased period. The
 * pose is set in steps a second and a half apart and nothing animates in
 * between, so the browser draws one frame per step instead of one per display
 * refresh, as a running CSS animation would. Each step moves the layer by
 * under a pixel or two, which reads as continuous. It holds still while the
 * tab is hidden or motion is reduced.
 */
export const GROW_PERIOD = 54_000
export const GROW_STEP = 1_500

export interface BackdropPose { x: number; y: number; scale: number }
/** Where a layer's drift starts (and rests while motion is reduced) and where it turns back. */
export interface BackdropDrift { from: BackdropPose; to: BackdropPose }

/** The pose at a moment: out for one period, back for the next, eased at both ends. */
export function backdropPose({ from, to }: BackdropDrift, elapsed: number): BackdropPose {
  const phase = (Math.max(0, elapsed) % (2 * GROW_PERIOD)) / GROW_PERIOD
  const along = (1 - Math.cos(Math.PI * (phase <= 1 ? phase : 2 - phase))) / 2
  const mix = (key: keyof BackdropPose) => from[key] + (to[key] - from[key]) * along
  return { x: mix('x'), y: mix('y'), scale: mix('scale') }
}

export const poseTransform = ({ x, y, scale }: BackdropPose) =>
  `translate3d(${x.toFixed(3)}%, ${y.toFixed(3)}%, 0) scale(${scale.toFixed(4)})`

/** Step the element along its drift until stopped; returns the stop. */
export function startGrowingBackdrop(element: HTMLElement, drift: BackdropDrift, reduced: () => boolean, now = () => performance.now()) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const step = () => {
    timer = undefined
    if (document.hidden) return
    element.style.transform = poseTransform(backdropPose(drift, reduced() ? 0 : now()))
    if (!reduced()) timer = setTimeout(step, GROW_STEP)
  }
  // A hidden tab schedules nothing; showing it again, or a change of the
  // reduced-motion choice, picks the pose up from the clock.
  const resume = () => { if (timer === undefined) step() }
  document.addEventListener('visibilitychange', resume)
  step()
  return {
    resume,
    stop() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', resume)
    },
  }
}
