// Phase-locked looping animation: an element created at any moment starts at
// the same point of a shared wall-clock cycle, so re-rendered lists never
// restart a pulse from frame zero (a visible jump).
export function loopPhaseDelay(periodMs: number, now: number = Date.now()): string {
  return `-${Math.floor(now % periodMs)}ms`
}