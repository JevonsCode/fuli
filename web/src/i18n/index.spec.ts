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

  it('uses the saved locale before browser language preferences', () => {
    expect(resolveInitialLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveInitialLocale('en-US', ['zh-CN'])).toBe('en-US')
  })

  it('maps browser language preferences to the supported locales', () => {
    expect(resolveInitialLocale(null, ['zh-Hant-TW'])).toBe('zh-CN')
    expect(resolveInitialLocale(null, ['en-GB'])).toBe('en-US')
    expect(resolveInitialLocale(null, ['fr-FR', 'zh-CN'])).toBe('zh-CN')
  })

  it('uses English when the browser has no supported language', () => {
    expect(resolveInitialLocale(null)).toBe('en-US')
    expect(resolveInitialLocale('fr-FR', ['fr-FR'])).toBe('en-US')
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
