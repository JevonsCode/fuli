import { afterEach, beforeEach } from 'vitest'

import { setLocale } from '@/i18n'

if (typeof HTMLDialogElement !== 'undefined') {
  if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '')
      },
    })
  }
  if (typeof HTMLDialogElement.prototype.close !== 'function') {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open')
        this.dispatchEvent(new Event('close'))
      },
    })
  }
}

// jsdom does no layout; reka-ui's listbox scrolls the highlighted option into view.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value() {} })
}

beforeEach(() => {
  window.localStorage.clear()
  setLocale('zh-CN', { persist: false })
})

afterEach(() => {
  document.body.replaceChildren()
})
