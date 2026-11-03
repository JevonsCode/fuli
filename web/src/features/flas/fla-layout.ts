import { ref } from 'vue'

// How the FLAs page lays its people out: cards (the default) or the dense
// list. Kept per browser like the interface language, so the page opens as
// the person left it.
export type FlaLayout = 'cards' | 'list'
const STORAGE_KEY = 'fuli.flas.layout'

function stored(): FlaLayout {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === 'list' ? 'list' : 'cards' } catch { return 'cards' }
}

const layout = ref<FlaLayout>(stored())

export function useFlaLayout() {
  function set(next: FlaLayout) {
    layout.value = next
    try {
      if (next === 'list') globalThis.localStorage?.setItem(STORAGE_KEY, 'list')
      else globalThis.localStorage?.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable; the choice still holds on this page.
    }
  }
  return { layout, set }
}
