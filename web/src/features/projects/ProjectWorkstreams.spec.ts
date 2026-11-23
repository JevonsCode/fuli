import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (actual) => ({ ...(await actual<typeof import('@/api/client')>()), getJson, postJson }))

import ProjectWorkstreams from './ProjectWorkstreams.vue'
import { ApiError } from '@/api/client'
import { setLocale, t } from '@/i18n'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import type { ProjectTeam, ProjectTeamPerson, ProjectWorkstream } from './project-team-api'

// docs/workstreams.md: the lead's ledger on the project page, and the
// person's one-step changes to it. Fictional people only.

const person = (agentId: string, name: string): ProjectTeamPerson => ({
  agentId, name, employeeNumber: null, occupationEmoji: null, responsibility: '', peerRole: false,
})

const line = (extra: Partial<ProjectWorkstream> = {}): ProjectWorkstream => ({
  assignmentId: 'line-spring', name: 'Spring sale page', terms: ['spring-sale'],
  ownerAgentId: 'fla-ember', ownerName: 'Ember Vale', ownerOnProject: true, decidedBy: 'host',
  startedAt: '2026-11-20T00:00:00.000Z', changedAt: '2026-11-20T00:00:00.000Z', revision: 1, latestTask: null, ...extra,
})

const team: ProjectTeam = {
  personalProjectId: 'project-a', status: 'ready',
  lead: person('fla-mara', 'Mara Quill'), unavailableLead: null,
  members: [person('fla-ember', 'Ember Vale'), person('fla-orin', 'Orin Pike')],
  collaborators: [], peers: [], unavailableMemberIds: [],
}

function serve(lines: ProjectWorkstream[]) {
  getJson.mockImplementation(async (url: string) => url.startsWith('/api/workstreams')
    ? { personalProjectId: 'project-a', workstreams: lines } : team)
}

function mountPanel() {
  return mount(ProjectWorkstreams, { attachTo: document.body,
    props: { spaceId: 'space-1', projectId: 'project-a' },
    global: { stubs: { RouterLink: RouterLinkStub, OptionSelect: optionSelectStubs.OptionSelect } } })
}

const refused = (code: string, extra: object = {}) =>
  new ApiError('refused', 409, JSON.stringify({ error: 'English server text', code, ...extra }))

describe('ProjectWorkstreams', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
    postJson.mockReset().mockResolvedValue({})
  })

  it('lists each line with its owner, its words, how far it got and who decided it', async () => {
    serve([line({ latestTask: { status: 'running', summary: 'New hero image', at: '2026-11-23T02:00:00.000Z' } }),
      line({ assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'], ownerAgentId: 'fla-orin',
        ownerName: 'Orin Pike', decidedBy: 'user', progressUnreadable: true })])
    const panel = mountPanel()
    await flushPromises()
    const rows = panel.findAll('[data-workstream]')
    expect(rows.map(row => row.get('.project-workstreams-name').text())).toEqual(['Spring sale page', 'Coupon centre'])
    expect((rows[0].get('select.project-workstreams-owner').element as HTMLSelectElement).value).toBe('fla-ember')
    // The project lead is never an option: a line exists to keep work off its desk.
    expect(rows[0].get('select.project-workstreams-owner').findAll('option').map(option => option.element.value)
      .filter(Boolean)).toEqual(['fla-ember', 'fla-orin'])
    expect(rows[0].get('[data-workstream-progress]').text()).toContain('New hero image')
    expect(rows[0].text()).toContain(t('projects.workstreams.byLead'))
    // A log that could not be read says so, never "no task".
    expect(rows[1].get('[data-workstream-progress]').text()).toContain(t('projects.workstreams.progressUnreadable'))
    expect(rows[1].text()).toContain(t('projects.workstreams.byYou'))
    panel.unmount()
  })

  it('changes the owner by picking a name, at the revision the page read', async () => {
    serve([line({ revision: 3 })])
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-workstream] select.project-workstreams-owner').setValue('fla-orin')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/standing-assignments/line-spring/reassign',
      { expectedRevision: 3, projectId: 'project-a', leadAgentId: 'fla-orin' })
    panel.unmount()
  })

  it('merges in one change: one request names both lines at the revisions read', async () => {
    serve([line(), line({ assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'],
      ownerAgentId: 'fla-orin', revision: 2 })])
    const panel = mountPanel()
    await flushPromises()
    await panel.findAll('[data-workstream]')[1].get('select.project-workstreams-merge').setValue('line-spring')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-coupon/merge',
      { into: 'line-spring', expectedRevision: 2, targetRevision: 1 }]])
    panel.unmount()
  })

  it('splits in one change: picked words of the line plus new ones, to another member', async () => {
    serve([line({ terms: ['spring-sale', 'coupon'], revision: 4 })])
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-split-workstream]').trigger('click')
    await panel.get('[data-term-chip="coupon"]').trigger('click')
    await panel.get('[data-workstream-name]').setValue('Coupon centre')
    await panel.get('[data-workstream-words]').setValue('voucher')
    await panel.get('.project-workstreams-form select').setValue('fla-orin')
    await panel.get('.project-workstreams-form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-spring/split', { expectedRevision: 4,
      terms: ['coupon'], extraTerms: ['voucher'], leadAgentId: 'fla-orin', responsibility: 'Coupon centre' }]])
    panel.unmount()
  })

  it('a second line for one FLA is refused in plain words with clickable next steps', async () => {
    serve([line({ revision: 5 })])
    postJson.mockRejectedValueOnce(refused('workstream_owner_has_line',
      { line: { assignmentId: 'line-spring', name: 'Spring sale page', revision: 5 } }))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-open-workstream]').trigger('click')
    await panel.get('[data-workstream-name]').setValue('Autumn sale')
    await panel.get('[data-workstream-words]').setValue('autumn-sale')
    await panel.get('.project-workstreams-form select').setValue('fla-ember')
    await panel.get('.project-workstreams-form').trigger('submit')
    await flushPromises()
    const notice = panel.get('[data-workstreams-problem]')
    expect(notice.text()).toContain('Spring sale page')
    expect(notice.text()).not.toContain('English server text')
    await notice.get('[data-add-to-line]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls.at(-1)).toEqual(['/api/standing-assignments/line-spring/terms',
      { expectedRevision: 5, addTerms: ['autumn-sale'] }])
    panel.unmount()
  })

  it('says a project is undivided, and over the LAN that lines are read only here', async () => {
    serve([])
    const panel = mountPanel()
    await flushPromises()
    expect(panel.get('[data-workstreams-empty]').text()).toBe(t('projects.workstreams.none'))
    panel.unmount()
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/workstreams')) throw new ApiError('no', 403, JSON.stringify({ code: 'local_user_only' }))
      return team
    })
    const remote = mountPanel()
    await flushPromises()
    expect(remote.get('[data-workstreams-local-only]').text()).toBe(t('projects.workstreams.localOnly'))
    expect(remote.find('[data-workstream]').exists()).toBe(false)
    remote.unmount()
  })
})
