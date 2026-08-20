import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { legacyKnowledgeHashPath, router } from './index'
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

  it('keeps the overview header concise', () => {
    expect(router.resolve('/').meta.eyebrow).toBe('')
  })

  it('registers writing taste as a concise child of collaboration preferences', () => {
    const route = router.resolve('/preferences/writing')
    expect(route.name).toBe('writing-taste')
    expect(route.meta.eyebrow).toBe('')
    expect(routeMetaText(route.meta.title)).toBe('写作偏好')
  })

  it('registers the concise project Agent directory', () => {
    const route = router.resolve('/project-agents')
    expect(route.name).toBe('project-agents')
    expect(route.meta.eyebrow).toBe('')
    expect(routeMetaText(route.meta.title)).toBe('项目 Agent')
  })

  it('registers the about page', () => {
    expect(router.resolve('/about').name).toBe('about')
    expect(routeMetaText(router.resolve('/about').meta.title)).toBe('说明')
  })

  it('registers settings as a separate page beside about', () => {
    expect(router.resolve('/settings').name).toBe('settings')
    expect(routeMetaText(router.resolve('/settings').meta.title)).toBe('设置')
  })

  it('resolves source marker links and upgrades legacy hash links', () => {
    expect(router.resolve(
      '/knowledge/personal/personal-space/directory/entity/knowledge-1',
    ).name).toBe('knowledge-item')
    expect(legacyKnowledgeHashPath(
      '#/knowledge/personal/personal-space/entity/knowledge-1',
    )).toBe('/knowledge/personal/personal-space/directory/entity/knowledge-1')
    expect(legacyKnowledgeHashPath('#/preferences')).toBeNull()
  })
})
