import { ref, shallowRef } from 'vue'
import { readRequesters } from './visit-request-api'
import type { RequesterMode } from './visit-request-shape'

// The mode each requester was given, one read shared by every mode control on
// the page; a requester never set reads as the server's default (计划). Until
// the first read answers no control shows a mode, so none is guessed. The
// modes can be changed in another window, so they are read again whenever this
// one is looked at again (focus, or the tab becoming visible): a mode shown
// here is never older than the last time the person came back to the page.
const known = shallowRef<ReadonlyMap<string, RequesterMode>>(new Map())
const fallback = ref<RequesterMode>('plan')
const loaded = ref(false)
let reading: Promise<void> | null = null
let watching = false

// One read at a time; a failed one keeps what is shown and lets the next try.
function refresh() {
  reading ??= readRequesters().then((answer) => {
    known.value = new Map(answer.requesters.map(requester => [requester.key, requester.mode]))
    fallback.value = answer.defaultMode
    loaded.value = true
  }, () => {}).finally(() => { reading = null })
  return reading
}

function watchReturn() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('focus', () => { void refresh() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh() })
}

export function useRequesterModes() {
  if (!loaded.value) void refresh()
  watchReturn()
  return {
    loaded,
    modeOf: (key: string) => known.value.get(key) ?? fallback.value,
    remember: (key: string, mode: RequesterMode) => { known.value = new Map(known.value).set(key, mode) },
    refresh,
  }
}
