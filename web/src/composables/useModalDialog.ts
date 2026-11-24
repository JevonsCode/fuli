import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'

import { POPUP_HOST } from '@/components/ui/popup-host'

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// A control the person types or picks in: opening a dialog on it saves them a step.
const fieldSelector = 'input:not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"]'

const POPUP_SELECTOR = '[data-reka-popper-content-wrapper]'

export function useModalDialog(open: () => boolean, requestClose: () => void) {
  const dialogRef = ref<HTMLDialogElement | null>(null)
  provide(POPUP_HOST, dialogRef)
  const initialFocusRef = ref<HTMLElement | null>(null)
  let returnFocus: HTMLElement | null = null
  let transition = 0
  // Esc with a popup open closes the popup alone. The popup's own handler removes
  // it before the dialog hears the request, so this looks first, at the window.
  let popupTakesEscape = false
  function notePopupEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') popupTakesEscape = Boolean(dialogRef.value?.querySelector(POPUP_SELECTOR))
  }
  onMounted(() => window.addEventListener('keydown', notePopupEscape, true))

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
        // An explicit target first. Else the content's first control when it is a
        // field; when it is a button or a link, the content itself (it scrolls with
        // the keys, and Tab goes on to that control). A button is not focused for
        // the person: WebKit draws the keyboard focus ring on a control focused
        // from script after a click, so a dialog opened with the mouse showed a
        // ring on a button nobody had reached (the statement's 上一周, on macOS).
        const body = dialog.querySelector<HTMLElement>('.ui-dialog__body')
        const first = body ? focusableElements(body)[0] : undefined
        const target = initialFocusRef.value
          ?? dialog.querySelector<HTMLElement>('[autofocus]')
          ?? (first?.matches(fieldSelector) ? first : body)
          ?? focusableElements(dialog)[0]
        target?.focus({ preventScroll: true })
      })
      return
    }

    const dialog = dialogRef.value
    if (dialog?.open) dialog.close()
    restoreFocus(currentTransition)
  }, { immediate: true })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', notePopupEscape, true)
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
    if (popupTakesEscape) popupTakesEscape = false
    else requestClose()
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

function focusableElements(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}
