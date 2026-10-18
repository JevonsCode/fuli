import { computed, ref } from 'vue'

// Glossary mode is on while Alt is held, or while the toolbar toggle pins it
// (touch screens have no Alt). One shared state for the whole console.
const held = ref(false)
const pinned = ref(false)

export function useGlossaryMode() {
  return {
    held,
    pinned,
    active: computed(() => held.value || pinned.value),
    toggle: () => { pinned.value = !pinned.value },
    reset: () => { held.value = false; pinned.value = false },
  }
}
