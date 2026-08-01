import { beforeEach } from 'vitest'

import { setLocale } from '@/i18n'

beforeEach(() => {
  window.localStorage.clear()
  setLocale('zh-CN', { persist: false })
})
