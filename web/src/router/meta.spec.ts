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

  it('puts the rebuilt pages on the shared work canvas and settings in the form column', () => {
    expect(['/', '/project-agents', '/agents/space/agent', '/project-agents/schedules', '/project-agents/manage', '/project-agents/manage/space/agent']
      .map(path => router.resolve(path).meta.layout))
      .toEqual(['canvas', 'canvas', 'canvas', 'canvas', 'canvas', 'canvas'])
    expect(router.resolve('/settings').meta.layout).toBe('form')
    // An Agent's profile and its 编排 page are detail pages; settings keeps a sticky save bar.
    expect(router.resolve('/agents/space/agent').meta.detail).toBe(true)
    expect(router.resolve('/project-agents/manage/space/agent').name).toBe('agent-management-detail')
    expect(router.resolve('/project-agents/manage/space/agent').meta.detail).toBe(true)
    expect(router.resolve('/project-agents/manage').meta.detail).toBeUndefined()
    expect(router.resolve('/project-agents').meta.detail).toBeUndefined()
    expect(router.resolve('/settings').meta.saveBar).toBe(true)
    // Pages not rebuilt yet keep their own layout.
    expect(router.resolve('/inbox').meta.layout).toBeUndefined()
  })

  it('puts the memory pages (knowledge, preferences, taste, organize) on the work canvas', () => {
    const paths = ['/knowledge', '/knowledge/personal/space/directory', '/knowledge/personal/space/graph/entity/item',
      '/preferences', '/preferences/writing', '/organize']
    expect(paths.map(path => router.resolve(path).meta.layout)).toEqual(paths.map(() => 'canvas'))
  })

  it('puts every personal project view (directory, graph, item, one project) on the work canvas', () => {
    const paths = ['/personal/space/projects/directory', '/personal/space/projects/graph/entity/item',
      '/personal/space/projects/project-1/graph', '/personal/space/projects/project-1/directory/entity/item']
    expect(paths.map(path => router.resolve(path).name))
      .toEqual(['personal-projects', 'personal-projects-item', 'personal-project', 'personal-project-item'])
    expect(paths.map(path => router.resolve(path).meta.layout)).toEqual(paths.map(() => 'canvas'))
  })

  it('titles the taste page the same as its section tab', () => {
    const route = router.resolve('/preferences/writing')
    expect(route.name).toBe('writing-taste')
    expect(routeMetaText(route.meta.title)).toBe('品味')
  })

  it('registers the concise project Agent directory', () => {
    const route = router.resolve('/project-agents')
    expect(route.name).toBe('project-agents')
    expect(routeMetaText(route.meta.title)).toBe('Agents')
  })

  it('localizes Agent profile and management routes', () => {
    expect(routeMetaText(router.resolve('/agents/space/agent').meta.title)).toBe('主页')
    expect(routeMetaText(router.resolve('/project-agents/manage').meta.title)).toBe('编排')
    // An Agent's 编排 page falls back to a name of its own, never the 「← 编排」 beside it.
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
    expect(route.meta.dedicatedWorkspace).toBe(true)
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
