import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useModalDialog(open: () => boolean, requestClose: () => void) {
  const dialogRef = ref<HTMLDialogElement | null>(null)
  const initialFocusRef = ref<HTMLElement | null>(null)
  let returnFocus: HTMLElement | null = null
  let transition = 0

  watch(open, (isOpen) => {
    const currentTransition = ++transition
    if (isOpen) {
      returnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      void nextTick().then(() => {
        if (currentTransition !== transition || !open()) return
        const dialog = dialogRef.value
        if (!dialog) return
        if (!dialog.open) dialog.showModal()
        const target = initialFocusRef.value ?? focusableElements(dialog)[0]
        target?.focus({ preventScroll: true })
      })
      return
    }

    const dialog = dialogRef.value
    if (dialog?.open) dialog.close()
    restoreFocus(currentTransition)
  }, { immediate: true })

  onBeforeUnmount(() => {
    transition += 1
    const dialog = dialogRef.value
    if (dialog?.open) dialog.close()
    const target = returnFocus
    returnFocus = null
    if (target?.isConnected) target.focus({ preventScroll: true })
  })

  function restoreFocus(currentTransition: number) {
    const target = returnFocus
    returnFocus = null
    void nextTick().then(() => {
      if (currentTransition !== transition || !target?.isConnected) return
      target.focus({ preventScroll: true })
    })
  }

  function onCancel(event: Event) {
    event.preventDefault()
    requestClose()
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.value
    if (!dialog) return
    const focusable = focusableElements(dialog)
    if (!focusable.length) {
      event.preventDefault()
      dialog.focus({ preventScroll: true })
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1) ?? first
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus({ preventScroll: true })
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }

  return { dialogRef, initialFocusRef, onCancel, onKeydown }
}

function focusableElements(dialog: HTMLDialogElement) {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}
