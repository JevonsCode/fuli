import { onBeforeUnmount, ref } from 'vue'

const SHOWN_MS = 1800

/**
 * Puts text on the clipboard and says so for a moment. `copied` is the key of
 * what was copied last (a button with several rows names each one); `failed`
 * is true when the clipboard refused, so the person can copy by hand.
 */
export function useClipboardCopy(shownMs = SHOWN_MS) {
  const copied = ref<string | null>(null)
  const failed = ref(false)
  let reset: ReturnType<typeof setTimeout> | undefined

  async function copy(key: string, text: string) {
    clearTimeout(reset)
    try {
      const clipboard = globalThis.navigator?.clipboard
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable')
      await clipboard.writeText(text)
      copied.value = key
      failed.value = false
    } catch {
      copied.value = null
      failed.value = true
    }
    reset = setTimeout(() => {
      copied.value = null
      failed.value = false
    }, shownMs)
  }
  onBeforeUnmount(() => clearTimeout(reset))
  return { copied, failed, copy }
}
