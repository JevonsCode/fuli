import { mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ProjectTeamSummary.vue', () => ({
  default: {
    name: 'ProjectTeamSummary',
    props: ['spaceId', 'projectId'],
    template: '<div data-team-summary-stub />',
  },
}))

vi.mock('@/features/capture/ProjectCaptureSwitch.vue', () => ({
  default: {
    name: 'ProjectCaptureSwitch',
    props: ['projectId', 'projectName'],
    template: '<div data-project-capture-stub />',
  },
}))

import { setLocale } from '@/i18n'
import type { PersonalProject } from '@/types'
import type { FrequentProjectSummary } from '@/features/knowledge/project-relation-weights'
import ProjectOverview from './ProjectOverview.vue'

function makeProject(): PersonalProject {
  return {
    project_id: 'fuli',
    personal_space_id: 'space-1',
    profile: {
      name: 'Fuli',
      purpose: 'Local-first project memory',
    },
  }
}

describe('ProjectOverview frequent projects section', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('renders at most 3 frequently queried formal projects with tier badges and reuse confirmation hint on 10+ queries', () => {
    const frequentProjects: FrequentProjectSummary[] = [
      {
        projectId: 'alpha',
        name: 'Alpha 架构库',
        recent30dCount: 12,
        totalCount: 15,
        lastUsedAt: '2026-10-18T00:00:00.000Z',
        tier: 'close',
        suggestKnowledgeReuse: true,
        requiresHumanConfirmation: true,
        grantsAccess: false,
      },
      {
        projectId: 'beta',
        name: 'Beta 组件库',
        recent30dCount: 5,
        totalCount: 8,
        lastUsedAt: '2026-10-17T00:00:00.000Z',
        tier: 'frequent',
        suggestKnowledgeReuse: false,
        requiresHumanConfirmation: true,
        grantsAccess: false,
      },
      {
        projectId: 'gamma',
        name: 'Gamma 规范',
        recent30dCount: 2,
        totalCount: 2,
        lastUsedAt: '2026-10-16T00:00:00.000Z',
        tier: 'related',
        suggestKnowledgeReuse: false,
        requiresHumanConfirmation: true,
        grantsAccess: false,
      },
      {
        projectId: 'delta',
        name: 'Delta 溢出项目',
        recent30dCount: 1,
        totalCount: 1,
        lastUsedAt: '2026-10-15T00:00:00.000Z',
        tier: 'related',
        suggestKnowledgeReuse: false,
        requiresHumanConfirmation: true,
        grantsAccess: false,
      },
    ]

    const wrapper = mount(ProjectOverview, {
      props: {
        spaceId: 'space-1',
        project: makeProject(),
        frequentProjects,
      },
      global: {
        stubs: { RouterLink: RouterLinkStub },
      },
    })

    const section = wrapper.get('[data-frequent-projects]')
    expect(section.text()).toContain('常查询的项目')
    const items = section.findAll('[data-frequent-project]')
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.attributes('data-frequent-project'))).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
    expect(items[0].attributes('data-weight-tier')).toBe('close')
    expect(items[0].text()).toContain('Alpha 架构库')
    expect(items[0].text()).toContain('密切')
    expect(items[0].find('[data-suggest-knowledge-reuse]').exists()).toBe(true)
    expect(items[0].text()).toContain('USES_KNOWLEDGE_FROM')

    expect(items[1].attributes('data-weight-tier')).toBe('frequent')
    expect(items[1].text()).toContain('常往来')
    expect(items[1].find('[data-suggest-knowledge-reuse]').exists()).toBe(false)

    expect(items[2].attributes('data-weight-tier')).toBe('related')
    expect(items[2].text()).toContain('有关系')
  })

  it('shows a calm empty state when there are no frequently queried projects yet', () => {
    const wrapper = mount(ProjectOverview, {
      props: {
        spaceId: 'space-1',
        project: makeProject(),
        frequentProjects: [],
      },
      global: {
        stubs: { RouterLink: RouterLinkStub },
      },
    })

    const section = wrapper.get('[data-frequent-projects]')
    expect(section.find('[data-frequent-projects-empty]').exists()).toBe(true)
    expect(section.findAll('[data-frequent-project]')).toHaveLength(0)
  })
})
