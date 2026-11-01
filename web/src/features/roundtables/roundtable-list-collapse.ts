import { ref } from 'vue'

// Whether the 圆桌 conversation list is folded to portraits. Kept per browser
// like the interface language, so the list opens as the person left it.
const STORAGE_KEY = 'fuli.roundtable.listCollapsed'

function stored() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) === '1' } catch { return false }
}

const collapsed = ref(stored())

export function useRoundtableListCollapse() {
  function toggle() {
    collapsed.value = !collapsed.value
    try {
      if (collapsed.value) globalThis.localStorage?.setItem(STORAGE_KEY, '1')
      else globalThis.localStorage?.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable; the choice still holds on this page.
    }
  }
  return { collapsed, toggle }
}
