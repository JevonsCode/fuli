import { ref, shallowRef } from 'vue'
import { readRequesters } from './visit-request-api'
import type { RequesterMode } from './visit-request-shape'

// The mode each requester was given, read once for every mode control on the
// page; a requester never set reads as the server's default (计划). Until the
// read answers no control shows a mode, so none is guessed.
const known = shallowRef<ReadonlyMap<string, RequesterMode>>(new Map())
const fallback = ref<RequesterMode>('plan')
const loaded = ref(false)
let reading: Promise<void> | null = null

function load() {
  reading ??= readRequesters().then((answer) => {
    known.value = new Map(answer.requesters.map(requester => [requester.key, requester.mode]))
    fallback.value = answer.defaultMode
    loaded.value = true
  }, () => { reading = null })
  return reading
}

export function useRequesterModes() {
  void load()
  return {
    loaded,
    modeOf: (key: string) => known.value.get(key) ?? fallback.value,
    remember: (key: string, mode: RequesterMode) => { known.value = new Map(known.value).set(key, mode) },
  }
}
