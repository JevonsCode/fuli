import { computed, inject, onBeforeUnmount, onMounted, provide, ref, type InjectionKey } from 'vue'

import { getJson } from '@/api/client'
import { refreshDoctorReport } from '@/features/doctor/doctor-report'
import type { ConnectionStatus } from './client-connection-model'

// Re-read configuration this often while the page is visible.
const RECHECK_MS = 15_000

/**
 * The clients' connection status, read while the settings' clients tab shows:
 * the status card (ClientConnectionSettings) and the manual card
 * (ClientManualConnection) share one observation and one write at a time.
 */
function useClientConnectionStatus() {
  const observation = ref<ConnectionStatus | null>(null)
  const checking = ref(false)
  const checkError = ref(false)
  // Writes in flight: no status read starts until they end. Between the clients
  // of 一键接入 nothing is in flight, so each client's new status is read as soon as it is written.
  const writes = ref(0)
  const connectingAll = ref(false)
  const writePending = computed(() => writes.value > 0)
  const busy = computed(() => writePending.value || connectingAll.value)
  let active = false
  let unmounted = false
  // Bumped whenever the view hides or a write starts, so a response requested before then is dropped.
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const watching = () => active && !unmounted && document.visibilityState === 'visible'
  // One request at a time; a response older than the shown one, or requested
  // before the view hid or a write began, never replaces it.
  async function check() {
    if (checking.value || writePending.value || !watching()) return
    clearTimeout(timer)
    checking.value = true
    const requested = generation
    let fresh = false
    try {
      const next = await getJson<ConnectionStatus>('/api/system/client-connection/status')
      fresh = requested === generation
      if (fresh && (!observation.value || next.observedAt >= observation.value.observedAt)) observation.value = next
      if (fresh) checkError.value = false
    } catch {
      fresh = requested === generation
      if (fresh) checkError.value = true
    } finally {
      checking.value = false
      // A dropped response is replaced at once if the view is watched again.
      if (fresh) schedule()
      else void check()
    }
  }
  // A write invalidates any observation in flight and reads the status again when it ends, before the
  // next write starts; the top bar's 设置 dot reads the doctor again too.
  async function writing(run: () => Promise<void>) {
    writes.value += 1
    generation += 1
    clearTimeout(timer)
    try { await run() } finally {
      writes.value -= 1
      generation += 1
      await check()
      void refreshDoctorReport()
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (watching()) timer = setTimeout(() => void check(), RECHECK_MS)
  }
  function returned() {
    if (document.visibilityState === 'visible') void check()
    else {
      generation += 1
      clearTimeout(timer)
    }
  }
  onMounted(() => {
    active = true
    document.addEventListener('visibilitychange', returned)
    window.addEventListener('focus', returned)
    void check()
  })
  onBeforeUnmount(() => {
    unmounted = true
    active = false
    generation += 1
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', returned)
    window.removeEventListener('focus', returned)
  })
  return { observation, checking, checkError, connectingAll, busy, check, writing }
}

export type ClientConnectionStatusState = ReturnType<typeof useClientConnectionStatus>
const STATUS_KEY: InjectionKey<ClientConnectionStatusState> = Symbol('client-connection-status')

/** Starts reading the clients' status for the cards below the calling component. */
export function provideClientConnectionStatus(): ClientConnectionStatusState {
  const state = useClientConnectionStatus()
  provide(STATUS_KEY, state)
  return state
}

/** The status the clients tab reads; its cards render only under that tab. */
export function injectClientConnectionStatus(): ClientConnectionStatusState {
  const state = inject(STATUS_KEY, null)
  if (!state) throw new Error('The client connection cards render under provideClientConnectionStatus')
  return state
}
