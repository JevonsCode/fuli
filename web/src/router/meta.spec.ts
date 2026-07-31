import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { routeMetaText, updateDocumentTitle } from './meta'

describe('localized route metadata', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('translates configured keys while preserving legacy literal metadata', () => {
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
})
