import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { ApiError } from '@/api/client'
import { isRunning, isTeamWork, readTeamSheets, type TeamSheet } from './team-sheets'

export type TeamWorkState = 'loading' | 'ready' | 'failed' | 'unsupported'
const REFRESH_MS = 15_000

// One read per space, shared by every widget that shows team work (the home
// cards, the island): a widget asks for it, and the read stops when the last
// one goes away. It refreshes while the window is visible. A server without
// the read (older than the team-work route) answers 404: that is "nothing to
// show", never an error on screen.
interface Source {
  sheets: Ref<TeamSheet[]>
  partial: Ref<boolean>
  state: Ref<TeamWorkState>
  reload: () => Promise<void>
  users: number
  stop: () => void
}
const sources = new Map<string, Source>()

function open(spaceId: string): Source {
  const existing = sources.get(spaceId)
  if (existing) { existing.users += 1; return existing }
  const scope = effectScope(true)
  const source = scope.run(() => {
    const sheets = ref<TeamSheet[]>([])
    const partial = ref(false)
    const state = ref<TeamWorkState>('loading')
    let controller: AbortController | null = null
    async function reload() {
      controller?.abort()
      const current = new AbortController()
      controller = current
      try {
        const result = await readTeamSheets(spaceId, current.signal)
        if (controller !== current) return
        sheets.value = result.workbenches.filter(isTeamWork)
        partial.value = result.partial
        state.value = 'ready'
      } catch (cause) {
        if (controller !== current || current.signal.aborted) return
        if (cause instanceof ApiError && cause.status === 404) state.value = 'unsupported'
        // A failed refresh keeps what was shown; only a first read reports failure.
        else if (state.value !== 'ready') state.value = 'failed'
      }
    }
    const timer = setInterval(() => {
      if (state.value !== 'unsupported' && document.visibilityState === 'visible') void reload()
    }, REFRESH_MS)
    void reload()
    return { sheets, partial, state, reload, users: 1, stop: () => { clearInterval(timer); controller?.abort() } }
  })!
  sources.set(spaceId, { ...source, stop: () => { source.stop(); scope.stop() } })
  return sources.get(spaceId)!
}

function close(spaceId: string) {
  const source = sources.get(spaceId)
  if (!source) return
  source.users -= 1
  if (source.users > 0) return
  source.stop()
  sources.delete(spaceId)
}

/** Team work in the person's active space: every open multi-FLA task, and the running ones. */
export function useTeamWork(spaceId: Ref<string>) {
  const current = shallowRef<Source | null>(null)
  watch(spaceId, (id, previous) => {
    if (previous) close(previous)
    current.value = id ? open(id) : null
  }, { immediate: true })
  onScopeDispose(() => { if (spaceId.value) close(spaceId.value) })
  const sheets = computed(() => current.value?.sheets.value ?? [])
  return {
    sheets,
    running: computed(() => sheets.value.filter(isRunning)),
    partial: computed(() => current.value?.partial.value ?? false),
    state: computed<TeamWorkState>(() => current.value?.state.value ?? 'loading'),
    reload: () => current.value?.reload() ?? Promise.resolve(),
  }
}

/** Tests start from no shared reads. */
export function forgetTeamWork() {
  for (const source of sources.values()) source.stop()
  sources.clear()
}
