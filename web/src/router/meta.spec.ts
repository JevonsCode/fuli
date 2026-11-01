import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { legacyKnowledgeHashPath, router } from './index'
import { routeMetaText, updateDocumentTitle } from './meta'

describe('localized route metadata', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('translates configured keys while preserving literal metadata', () => {
    expect(routeMetaText('routes.overview.title')).toBe('工作台')
    expect(routeMetaText('Legacy title')).toBe('Legacy title')
    expect(routeMetaText('attention.title')).toBe('待决策')

    setLocale('en-US', { persist: false })
    expect(routeMetaText('routes.overview.title')).toBe('Workspace')
  })

  it('updates the browser title for the active locale', () => {
    setLocale('en-US', { persist: false })
    updateDocumentTitle('routes.knowledge.title')
    expect(document.title).toBe('Knowledge · FULI')
  })

  it('keeps the organizer header concise', () => {
    expect(router.resolve('/organize').meta.description).toBeUndefined()
  })

  it('gives no route an eyebrow: the shell H1 is the only page title', () => {
    expect(router.getRoutes().filter(route => 'eyebrow' in route.meta).map(route => route.path)).toEqual([])
  })

  it('marks record pages as details and keeps the sticky save bar on settings', () => {
    // An Agent's profile and its 编排 page are detail pages; settings keeps a sticky save bar.
    expect(router.resolve('/agents/space/agent').meta.detail).toBe(true)
    expect(router.resolve('/project-agents/manage/space/agent').name).toBe('agent-management-detail')
    expect(router.resolve('/project-agents/manage/space/agent').meta.detail).toBe(true)
    expect(router.resolve('/project-agents/manage').meta.detail).toBeUndefined()
    expect(router.resolve('/project-agents').meta.detail).toBeUndefined()
    expect(router.resolve('/project-agents/occupations').meta.detail).toBeUndefined()
    expect(router.resolve('/settings').meta.saveBar).toBe(true)
    const workbench = router.resolve('/employees/jefa')
    expect(workbench.name).toBe('employee-workbench')
    expect(workbench.meta.detail).toBe(true)
  })

  it('opens the shared report outside the shell, with its own header', () => {
    expect(router.getRoutes().filter(route => route.meta.publicReport).map(route => route.path)).toEqual(['/reports/jefa'])
  })

  it('resolves every personal project directory and graph to its own route', () => {
    const paths = ['/personal/space/projects/directory', '/personal/space/projects/graph/entity/item',
      '/personal/space/projects/project-1/graph', '/personal/space/projects/project-1/directory/entity/item']
    expect(paths.map(path => router.resolve(path).name))
      .toEqual(['personal-projects', 'personal-projects-item', 'personal-project', 'personal-project-item'])
  })

  it('registers the concise project Agent directory', () => {
    const route = router.resolve('/project-agents')
    expect(route.name).toBe('project-agents')
    expect(routeMetaText(route.meta.title)).toBe('Agents')
  })

  it('localizes Agent profile and management routes', () => {
    expect(routeMetaText(router.resolve('/agents/space/agent').meta.title)).toBe('主页')
    expect(routeMetaText(router.resolve('/project-agents/manage').meta.title)).toBe('编排')
    // An Agent's 编排 page falls back to a name of its own, never the 编排 crumb above it.
    expect(routeMetaText(router.resolve('/project-agents/manage/space/agent').meta.title)).toBe('Agent')
    setLocale('en-US', { persist: false })
    expect(routeMetaText(router.resolve('/agents/space/agent').meta.title)).toBe('Profile')
  })

  it('registers the about page', () => {
    expect(router.resolve('/about').name).toBe('about')
    expect(routeMetaText(router.resolve('/about').meta.title)).toBe('关于')
  })

  it('localizes the employee workbench title in both supported languages', () => {
    const route = router.resolve('/employees/jefa')
    expect(routeMetaText(route.meta.title)).toBe('专属 Agent')
    setLocale('en-US', { persist: false })
    expect(routeMetaText(route.meta.title)).toBe('Specialist Agents')
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
