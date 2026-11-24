// An FLA's last recorded change on a task, as a fact: when it was, or that
// none was recorded. One reading for every place that shows running work — the
// 现在 line on an FLA's page and the 团队卡片 under it — so the two never
// disagree about the same task. It never concludes that work stopped: a task
// the records call running reads 正在做 however long ago its last change was,
// and the line says when that change was (Jevons 11-25: 「这个不能写太死」).

/**
 * Only whether the dot breathes: a recorded change this recent pulses it.
 * It is not the task's state and never changes any words.
 */
export const PULSE_WITHIN_MS = 30 * 60_000

/** When the last change was recorded (null: none was), and whether it is recent enough to pulse the dot. */
export interface LastProgress { at: string | null; pulse: boolean }

/** The last recorded change on a task, at `now`. */
export function lastProgressOf(lastUpdateAt: string | null, now: number): LastProgress {
  const at = lastUpdateAt ? Date.parse(lastUpdateAt) : Number.NaN
  if (!lastUpdateAt || Number.isNaN(at)) return { at: null, pulse: false }
  return { at: lastUpdateAt, pulse: now - at <= PULSE_WITHIN_MS }
}
