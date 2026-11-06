import { computed, ref } from 'vue'

// Glossary mode is on while Alt is held, or while the toolbar toggle pins it
// (touch screens have no Alt). One shared state for the whole console.
const held = ref(false)
const pinned = ref(false)
// The term whose explanation is open: from a click in glossary mode, or a
// card's own 「?」 (features/ai-help/AiHelpButton.vue).
const explaining = ref<{ termId: string; anchor: DOMRect } | null>(null)

export function useGlossaryMode() {
  return {
    held,
    pinned,
    explaining,
    active: computed(() => held.value || pinned.value),
    toggle: () => { pinned.value = !pinned.value },
    reset: () => { held.value = false; pinned.value = false },
    explain: (termId: string, anchor: DOMRect) => { explaining.value = { termId, anchor } },
  }
}
