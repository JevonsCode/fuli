import { describe, expect, it } from 'vitest'

import { router } from './index'
import { legacyRouteFromUrl } from './legacy'
import { knowledgePath, personalProjectsPath } from './paths'

describe('legacy console URL migration', () => {
  it('moves personal project view, scope, space, and mode into the path', () => {
    const target = legacyRouteFromUrl(new URL(
      'http://localhost/?view=personal-projects&mode=graph&scope=personal'
      + '&space=795d67de-d07e-45a8-82fc-d0105b52e6d3',
    ))

    expect(target).toEqual({
      path: '/personal/795d67de-d07e-45a8-82fc-d0105b52e6d3/projects/graph',
      query: {},
    })
  })

  it('keeps optional filters while moving navigation identity into the path', () => {
    const target = legacyRouteFromUrl(new URL(
      'http://localhost/?view=graph&mode=directory&scope=public&space=shared-1'
      + '&q=release&type=Decision&context=a&context=b',
    ))

    expect(target).toEqual({
      path: '/knowledge/public/shared-1/directory',
      query: { q: 'release', type: 'Decision', context: ['a', 'b'] },
    })
  })

  it('converts source marker hashes to an exact knowledge item route', () => {
    const target = legacyRouteFromUrl(new URL(
      'http://localhost/#/knowledge/personal/personal%20space/relationship/relation%2F1',
    ))

    expect(target).toEqual({
      path: '/knowledge/personal/personal%20space/directory/relationship/relation%2F1',
    })
  })
})

describe('Vue route builders', () => {
  it('builds aggregate and project-scoped personal routes', () => {
    expect(personalProjectsPath('space-1', 'graph')).toBe(
      '/personal/space-1/projects/graph',
    )
    expect(personalProjectsPath('space-1', 'directory', 'project-1')).toBe(
      '/personal/space-1/projects/project-1/directory',
    )
    expect(personalProjectsPath('space-1', 'directory', 'project-1', {
      itemKind: 'entity',
      itemId: 'project-profile:purpose/one',
    })).toBe(
      '/personal/space-1/projects/project-1/directory/entity/project-profile%3Apurpose%2Fone',
    )
  })

  it('builds deep knowledge routes without Provider URLs', () => {
    expect(knowledgePath('public', 'project-1', 'directory', {
      itemKind: 'entity',
      itemId: 'entity-1',
    })).toBe('/knowledge/public/project-1/directory/entity/entity-1')
  })

  it('resolves project item routes before their shorter project routes', () => {
    const location = router.resolve(
      '/personal/space-1/projects/project-1/graph/entity/purpose-1',
    )

    expect(location.name).toBe('personal-project-item')
    expect(location.params).toEqual({
      spaceId: 'space-1',
      projectId: 'project-1',
      mode: 'graph',
      itemKind: 'entity',
      itemId: 'purpose-1',
    })
  })
})
