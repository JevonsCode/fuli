import { beforeEach, describe, expect, it } from 'vitest'

import {
  currentLocale,
  LOCALE_STORAGE_KEY,
  messages,
  resolveInitialLocale,
  setLocale,
  t,
} from './index'

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setLocale('zh-CN', { persist: false })
  })

  it('keeps Chinese as the compatibility default', () => {
    expect(resolveInitialLocale(null)).toBe('zh-CN')
    expect(resolveInitialLocale('fr-FR')).toBe('zh-CN')
  })

  it('switches between the two supported locales and interpolates values', () => {
    expect(t('common.counts.items', { count: 2 })).toBe('2 条')

    setLocale('en-US')

    expect(currentLocale()).toBe('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')
    expect(t('common.counts.items', { count: 1 })).toBe('1 item')
    expect(t('common.counts.items', { count: 2 })).toBe('2 items')
  })

  it('keeps the Chinese and English message trees structurally aligned', () => {
    expect(messageKeys(messages['en-US'])).toEqual(messageKeys(messages['zh-CN']))
  })
})

function messageKeys(
  value: Record<string, unknown>,
  prefix = '',
): string[] {
  return Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return child && typeof child === 'object'
        ? messageKeys(child as Record<string, unknown>, path)
        : [path]
    })
    .sort()
}
