export interface DebouncedAction {
  schedule: () => void
  flush: () => void
  cancel: () => void
}

export function createDebouncedAction(
  callback: () => void,
  delayMs: number,
): DebouncedAction {
  let timer: ReturnType<typeof setTimeout> | null = null

  function run() {
    timer = null
    callback()
  }

  return {
    schedule() {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(run, delayMs)
    },
    flush() {
      if (timer === null) return
      clearTimeout(timer)
      run()
    },
    cancel() {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    },
  }
}
