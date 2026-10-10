import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson }))

import ProjectTeamSummary from './ProjectTeamSummary.vue'
import { setLocale, t } from '@/i18n'
import type { ProjectTeam, ProjectTeamPerson } from './project-team-api'

const person = (agentId: string, extra: Partial<ProjectTeamPerson> = {}): ProjectTeamPerson => ({
  agentId, name: agentId, employeeNumber: null, occupationEmoji: null,
  responsibility: `${agentId} work`, peerRole: false, ...extra,
})

function team(extra: Partial<ProjectTeam> = {}): ProjectTeam {
  return {
    personalProjectId: 'project-a', status: 'ready',
    lead: person('Lead', { employeeNumber: '000101' }), unavailableLead: null,
    members: [person('Member', { reportsToAgentId: 'Lead' })],
    collaborators: [person('Helper')], peers: [person('Bole', { peerRole: true })],
    unavailableMemberIds: [], ...extra,
  }
}

function mountSummary() {
  return mount(ProjectTeamSummary, {
    attachTo: document.body,
    props: { spaceId: 'space-1', projectId: 'project-a' },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}

describe('ProjectTeamSummary', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
  })

  it('shows the one lead first and expands the organization inline from that row', async () => {
    getJson.mockResolvedValue(team())
    const wrapper = mountSummary()
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/project-team?personalSpaceId=space-1&personalProjectId=project-a')
    const lead = wrapper.get('button.project-team-lead')
    expect(lead.text()).toContain('Lead')
    expect(lead.text()).toContain('FLA 000101')
    expect(lead.findAll('a')).toHaveLength(0)
    expect(lead.attributes('aria-expanded')).toBe('false')
    const panel = wrapper.get(`#${lead.attributes('aria-controls')}`)
    expect(panel.isVisible()).toBe(false)
    await lead.trigger('click')
    expect(lead.attributes('aria-expanded')).toBe('true')
    expect(panel.isVisible()).toBe(true)
    expect(panel.get('.is-members').text()).toContain('Member')
    expect(panel.get('.is-collaborators').text()).toContain('Helper')
    expect(panel.get('.is-peers').text()).toContain('Bole')
  })

  it('counts other assignments in the collapsed summary instead of claiming nobody is assigned', async () => {
    getJson.mockResolvedValue(team({ members: [] }))
    const wrapper = mountSummary()
    await flushPromises()
    const summary = wrapper.get('.project-team-preview').text()
    expect(summary).toContain(t('projects.overview.collaboratorCount', { count: 1 }))
    expect(summary).toContain(t('projects.overview.peerCount', { count: 1 }))
    expect(summary).not.toContain(t('projects.overview.noMembers'))
  })

  it('reports a missing or unavailable lead truthfully with one action', async () => {
    getJson.mockResolvedValue(team({ status: 'lead_unavailable', lead: null,
      unavailableLead: { agentId: 'Former', name: 'Former' }, unavailableMemberIds: ['gone'] }))
    const wrapper = mountSummary()
    await flushPromises()
    expect(wrapper.find('button.project-team-lead').exists()).toBe(false)
    expect(wrapper.text()).toContain(t('projects.overview.leadUnavailable', { name: 'Former' }))
    const actions = wrapper.findAllComponents(RouterLinkStub).filter(link => link.classes('primary-button'))
    expect(actions).toHaveLength(1)
    expect(actions[0].props('to')).toEqual({ path: '/project-agents/manage', query: { project: 'project-a' } })
    expect(wrapper.text()).toContain(t('projects.overview.unavailableMembers', { count: 1 }))
  })

  it('keeps the last team visible and says so when a refresh fails', async () => {
    getJson.mockResolvedValueOnce(team())
    const wrapper = mountSummary()
    await flushPromises()
    getJson.mockRejectedValueOnce(new Error('offline'))
    await wrapper.get(`button[aria-label="${t('projects.overview.refresh')}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.get('button.project-team-lead').text()).toContain('Lead')
    expect(wrapper.get('.project-team-stale').text()).toContain(t('projects.overview.refreshFailed'))
  })
})
