import { onScopeDispose, shallowReactive } from 'vue'

/** One page resource, one bounded user-initiated round. No retries or polling. */
export function overviewResource<T>(onDenied?: () => void) {
  const state = shallowReactive({ data: null as T | null, loading: false, slow: false,
    error: '', status: null as number | null, updatedAt: null as string | null })
  let generation = 0
  let cancel: (() => void) | undefined
  function reset() {
    generation++
    cancel?.()
    cancel = undefined
    Object.assign(state, { data: null, loading: false, slow: false, error: '', status: null, updatedAt: null })
  }
  async function load(read: (signal: AbortSignal) => Promise<T>) {
    if (state.loading) return
    const current = ++generation
    const controller = new AbortController()
    state.loading = true; state.slow = false; state.error = ''; state.status = null
    await new Promise<void>(done => {
      const slow = setTimeout(() => { if (current === generation) state.slow = true }, 8000)
      const timeout = setTimeout(() => {
        if (current === generation) {
          generation++
          state.error = 'timeout'; state.loading = false; state.slow = false
          controller.abort()
        }
        finish()
      }, 30000)
      function finish() {
        clearTimeout(slow); clearTimeout(timeout)
        if (current === generation) { state.loading = false; state.slow = false; cancel = undefined }
        done()
      }
      cancel = () => { controller.abort(); finish() }
      let result: Promise<T>
      try { result = read(controller.signal) } catch (cause) { result = Promise.reject(cause) }
      result.then(value => {
        if (current !== generation) return
        state.data = value; state.updatedAt = new Date().toISOString()
      }, cause => {
        if (current !== generation) return
        const status = typeof cause?.status === 'number' ? cause.status : null
        state.status = status
        if (status === 401 || status === 403) {
          state.data = null; state.updatedAt = null; state.error = 'denied'
          onDenied?.()
        } else state.error = 'failed'
      }).finally(finish)
    })
  }
  onScopeDispose(reset)
  return { state, load, reset }
}
