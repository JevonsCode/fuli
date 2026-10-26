import { ref } from 'vue'

/** A sent delete must settle before its dialog can be dismissed. */
export function useHardDeleteDialog() {
  const open = ref(false)
  const pending = ref(false)
  function changeOpen(value: boolean) {
    if (value || !pending.value) open.value = value
  }
  function guardDismiss(event: Event) {
    if (pending.value) event.preventDefault()
  }
  return { open, pending, changeOpen, guardDismiss }
}
