import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'

export type SharedReadState = 'loading' | 'ready' | 'failed'

interface Source<T> {
  value: Ref<T | null>
  state: Ref<SharedReadState>
  /** The reason the last read failed, for a caller that tells failures apart. */
  error: Ref<unknown>
  reload: () => Promise<void>
  users: number
  stop: () => void
}

/**
 * One read per key, shared by every component on screen that shows it (an
 * FLA's work locations, its task sheets): the first user starts the read, the
 * last one to go away stops it. A failed reload keeps what was shown.
 */
export function sharedRead<T>(read: (key: readonly string[], signal: AbortSignal) => Promise<T>) {
  const sources = new Map<string, Source<T>>()
  const keyOf = (key: readonly string[]) => key.join('\u0000')

  function open(key: readonly string[]): Source<T> {
    const existing = sources.get(keyOf(key))
    if (existing) { existing.users += 1; return existing }
    const scope = effectScope(true)
    let controller: AbortController | null = null
    const source = scope.run(() => {
      const value = ref<T | null>(null) as Ref<T | null>
      const state = ref<SharedReadState>('loading')
      const error = ref<unknown>(null)
      async function reload() {
        controller?.abort()
        const current = new AbortController()
        controller = current
        try {
          const result = await read(key, current.signal)
          if (controller !== current) return
          value.value = result
          state.value = 'ready'
        } catch (cause) {
          if (controller !== current || current.signal.aborted) return
          error.value = cause
          if (state.value !== 'ready') state.value = 'failed'
        }
      }
      void reload()
      return { value, state, error, reload }
    })!
    const opened: Source<T> = { ...source, users: 1, stop: () => { controller?.abort(); scope.stop() } }
    sources.set(keyOf(key), opened)
    return opened
  }

  function close(key: readonly string[]) {
    const source = sources.get(keyOf(key))
    if (!source) return
    source.users -= 1
    if (source.users > 0) return
    source.stop()
    sources.delete(keyOf(key))
  }

  /** The shared read for a key; an empty part in the key means nothing to read yet. */
  function use(key: Ref<readonly string[]>) {
    const current = shallowRef<Source<T> | null>(null)
    let opened: readonly string[] | null = null
    watch(() => keyOf(key.value), () => {
      if (opened) close(opened)
      opened = key.value.every(Boolean) ? [...key.value] : null
      current.value = opened ? open(opened) : null
    }, { immediate: true })
    onScopeDispose(() => { if (opened) close(opened) })
    return {
      value: computed(() => current.value?.value.value ?? null),
      state: computed<SharedReadState>(() => current.value?.state.value ?? 'loading'),
      error: computed(() => current.value?.error.value ?? null),
      reload: () => current.value?.reload() ?? Promise.resolve(),
    }
  }

  /** Tests start from no shared reads. */
  function forget() {
    for (const source of sources.values()) source.stop()
    sources.clear()
  }

  return { use, forget }
}
