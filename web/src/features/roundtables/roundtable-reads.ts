// Reads on the conversations page. Each read belongs to a scope (the space, or
// the open detail) and ends when that scope ends or after a deadline, so a
// stuck request never outlives what it was for and never blocks the next one.
export const READ_LIMIT_MS = 30_000

export interface ReadScope {
  readonly active: boolean
  end(): void
  read<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T>
}

export function createReadScope(limitMs = READ_LIMIT_MS): ReadScope {
  const controller = new AbortController()
  return {
    get active() { return !controller.signal.aborted },
    end() { controller.abort() },
    read(run) {
      const request = new AbortController()
      const stop = () => request.abort()
      if (controller.signal.aborted) stop()
      else controller.signal.addEventListener('abort', stop, { once: true })
      const timer = setTimeout(stop, limitMs)
      return run(request.signal).finally(() => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', stop)
      })
    },
  }
}

// One run at a time. A call while one runs either asks for exactly one more run
// after it (a change signal) or is dropped (a timed refresh).
export function singleFlight(run: () => Promise<void>) {
  let running: Promise<void> | null = null
  let again = false
  return (rerun = true): Promise<void> => {
    if (running) {
      again ||= rerun
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          await run()
        } while (again)
      } finally {
        running = null
      }
    })()
    return running
  }
}

// Runs tasks one after another, so a later task always starts from what the
// earlier one left behind.
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => undefined)
    return next
  }
}
