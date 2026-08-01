import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { router } from './index'
import { routeMetaText, updateDocumentTitle } from './meta'

describe('localized route metadata', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('translates configured keys while preserving literal metadata', () => {
    expect(routeMetaText('routes.overview.title')).toBe('概览')
    expect(routeMetaText('Legacy title')).toBe('Legacy title')

    setLocale('en-US', { persist: false })
    expect(routeMetaText('routes.overview.title')).toBe('Overview')
  })

  it('updates the browser title for the active locale', () => {
    setLocale('en-US', { persist: false })
    updateDocumentTitle('routes.knowledge.title')
    expect(document.title).toBe('Knowledge base · FULI')
  })

  it('keeps the organizer header concise', () => {
    expect(router.resolve('/organize').meta.description).toBeUndefined()
  })

  it('registers the about page', () => {
    expect(router.resolve('/about').name).toBe('about')
    expect(routeMetaText(router.resolve('/about').meta.title)).toBe('说明')
  })

  it('registers settings as a separate page beside about', () => {
    expect(router.resolve('/settings').name).toBe('settings')
    expect(routeMetaText(router.resolve('/settings').meta.title)).toBe('设置')
  })
})
