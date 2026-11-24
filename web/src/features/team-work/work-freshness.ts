// Whether an FLA's work on a task is still going on, read from its last
// recorded change only. One reading for every place that says 正在做 — the
// 现在 line on an FLA's page and the 团队卡片 under it — so the two never
// disagree about the same task.

/** Running work with no recorded change for this long is no longer said to be going on. */
export const STALE_AFTER_MS = 30 * 60_000

/**
 * How recent the FLA's last recorded change on a task is: `fresh` within
 * STALE_AFTER_MS, `stale` past it, `unrecorded` when no change was recorded.
 * Only `fresh` reads as 正在做 with a live dot.
 */
export type Progress = { state: 'fresh' | 'stale'; at: string } | { state: 'unrecorded' }

/** How recent a task's last recorded change is, at `now`. */
export function progressOf(lastUpdateAt: string | null, now: number): Progress {
  const at = lastUpdateAt ? Date.parse(lastUpdateAt) : Number.NaN
  if (!lastUpdateAt || Number.isNaN(at)) return { state: 'unrecorded' }
  return { state: now - at <= STALE_AFTER_MS ? 'fresh' : 'stale', at: lastUpdateAt }
}
