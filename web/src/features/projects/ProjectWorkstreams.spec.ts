import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson, postJson }))

import ProjectWorkstreams from './ProjectWorkstreams.vue'
import { setLocale, t } from '@/i18n'
import type { ProjectTeam, ProjectTeamPerson, ProjectWorkstream } from './project-team-api'

// docs/workstreams.md: the lead's ledger on the project page, and the
// person's one-step changes to it. Fictional people only.

const person = (agentId: string, name: string): ProjectTeamPerson => ({
  agentId, name, employeeNumber: null, occupationEmoji: null, responsibility: '', peerRole: false,
})

const line = (extra: Partial<ProjectWorkstream> = {}): ProjectWorkstream => ({
  assignmentId: 'line-spring', name: 'Spring sale page', terms: ['spring-sale'],
  ownerAgentId: 'fla-ember', ownerName: 'Ember Vale', ownerOnProject: true, decidedBy: 'host',
  startedAt: '2026-11-20T00:00:00.000Z', changedAt: '2026-11-20T00:00:00.000Z', revision: 1, ...extra,
})

function team(workstreams: ProjectWorkstream[]): ProjectTeam {
  return {
    personalProjectId: 'project-a', status: 'ready',
    lead: person('fla-mara', 'Mara Quill'), unavailableLead: null,
    members: [person('fla-ember', 'Ember Vale'), person('fla-orin', 'Orin Pike')],
    collaborators: [], peers: [], unavailableMemberIds: [], workstreams,
  }
}

function mountPanel() {
  return mount(ProjectWorkstreams, { attachTo: document.body,
    props: { spaceId: 'space-1', projectId: 'project-a' } })
}

describe('ProjectWorkstreams', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
    postJson.mockReset().mockResolvedValue({})
  })

  it('lists each line with its owner, its words and who decided it', async () => {
    getJson.mockResolvedValue(team([line(), line({ assignmentId: 'line-coupon', name: 'Coupon centre',
      terms: ['coupon'], ownerAgentId: 'fla-orin', ownerName: 'Orin Pike', decidedBy: 'user' })]))
    const panel = mountPanel()
    await flushPromises()
    const rows = panel.findAll('[data-workstream]')
    expect(rows.map(row => row.get('.project-workstreams-name').text()))
      .toEqual(['Spring sale page', 'Coupon centre'])
    expect(rows[0].get('select').element.value).toBe('fla-ember')
    expect(rows[0].text()).toContain(t('projects.workstreams.byLead'))
    expect(rows[1].text()).toContain(t('projects.workstreams.byYou'))
    // The project lead is never an option: a workstream exists to keep work off its desk.
    expect(rows[0].get('.project-workstreams-owner').findAll('option').map(option => option.element.value))
      .toEqual(['fla-ember', 'fla-orin'])
    panel.unmount()
  })

  it('changes the owner in one step, at the revision the page read', async () => {
    getJson.mockResolvedValue(team([line({ revision: 3 })]))
    const panel = mountPanel()
    await flushPromises()
    const owner = panel.get('[data-workstream] select')
    await owner.setValue('fla-orin')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/standing-assignments/line-spring/reassign',
      { expectedRevision: 3, projectId: 'project-a', leadAgentId: 'fla-orin' })
    expect(getJson).toHaveBeenCalledTimes(2)
    panel.unmount()
  })

  it('merges one line into another: its words move, then it ends', async () => {
    const coupon = line({ assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'],
      ownerAgentId: 'fla-orin', revision: 2 })
    getJson.mockResolvedValue(team([line(), coupon]))
    const panel = mountPanel()
    await flushPromises()
    await panel.findAll('[data-workstream]')[1].get('.project-workstreams-merge select').setValue('line-spring')
    await flushPromises()
    expect(postJson.mock.calls.map(call => call[0])).toEqual([
      '/api/standing-assignments/line-spring/terms', '/api/standing-assignments/line-coupon/retire'])
    expect(postJson.mock.calls[0][1]).toEqual({ expectedRevision: 1, addTerms: ['coupon'] })
    panel.unmount()
  })

  it('opening a line with words another line holds splits them off first', async () => {
    getJson.mockResolvedValue(team([line({ terms: ['spring-sale', 'coupon'], revision: 4 })]))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-open-workstream]').trigger('click')
    await panel.findAll('.project-workstreams-form input')[0].setValue('Coupon centre')
    await panel.findAll('.project-workstreams-form input')[1].setValue('coupon')
    await panel.get('.project-workstreams-form select').setValue('fla-orin')
    expect(panel.get('.project-workstreams-moving').text()).toContain('Spring sale page')
    await panel.get('.project-workstreams-form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([
      ['/api/standing-assignments/line-spring/terms', { expectedRevision: 4, removeTerms: ['coupon'] }],
      ['/api/standing-assignments', { personalProjectId: 'project-a', leadAgentId: 'fla-orin',
        terms: ['coupon'], responsibility: 'Coupon centre' }],
    ])
    panel.unmount()
  })

  it('a refused change leaves the list alone and says why', async () => {
    getJson.mockResolvedValue(team([line()]))
    postJson.mockRejectedValue(new Error('This workstream changed since it was read.'))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-workstream] select').setValue('fla-orin')
    await flushPromises()
    expect(panel.get('.project-workstreams-error').text()).toBe('This workstream changed since it was read.')
    expect(panel.findAll('[data-workstream]')).toHaveLength(1)
    panel.unmount()
  })

  it('says a project is undivided rather than showing nothing', async () => {
    getJson.mockResolvedValue(team([]))
    const panel = mountPanel()
    await flushPromises()
    expect(panel.get('[data-workstreams-empty]').text()).toBe(t('projects.workstreams.none'))
    expect(panel.find('[data-open-workstream]').exists()).toBe(true)
    panel.unmount()
  })
})
