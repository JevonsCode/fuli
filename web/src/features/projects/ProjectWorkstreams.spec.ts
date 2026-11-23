import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (actual) => ({ ...(await actual<typeof import('@/api/client')>()), getJson, postJson }))

import ProjectWorkstreams from './ProjectWorkstreams.vue'
import { ApiError } from '@/api/client'
import { setLocale, t } from '@/i18n'
import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import type { ClosedWorkstream, ProjectTeam, ProjectTeamPerson, ProjectWorkstream } from './project-team-api'

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

function serve(lines: ProjectWorkstream[], closed: ClosedWorkstream[] = []) {
  getJson.mockImplementation(async (url: string) => url.startsWith('/api/workstreams')
    ? { personalProjectId: 'project-a', workstreams: lines, closed } : team)
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

  it('merges in one change after one confirmation that says what happens and how it is undone', async () => {
    serve([line(), line({ assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'],
      ownerAgentId: 'fla-orin', revision: 2 })])
    const panel = mountPanel()
    await flushPromises()
    await panel.findAll('[data-workstream]')[1].get('select.project-workstreams-merge').setValue('line-spring')
    await flushPromises()
    // Nothing is sent before the person confirms.
    expect(postJson).not.toHaveBeenCalled()
    const dialog = panel.get('[data-workstream-confirm]')
    expect(dialog.text()).toContain(t('projects.workstreams.mergeEffect',
      { from: 'Coupon centre', into: 'Spring sale page', owner: 'Ember Vale' }))
    await dialog.get('[data-confirm-change]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-coupon/merge',
      { into: 'line-spring', expectedRevision: 2, targetRevision: 1 }]])
    panel.unmount()
  })

  it('ends a line only after a confirmation; cancelling sends nothing', async () => {
    serve([line({ revision: 6 })])
    const panel = mountPanel()
    await flushPromises()
    const endButton = () => panel.get(`[aria-label="${t('projects.workstreams.end', { name: 'Spring sale page' })}"]`)
    await endButton().trigger('click')
    expect(panel.get('[data-workstream-confirm]').text()).toContain(t('projects.workstreams.endEffect'))
    await panel.get('[data-workstream-confirm]').findAll('button').find(button =>
      button.text() === t('projects.workstreams.cancel'))!.trigger('click')
    expect(panel.find('[data-workstream-confirm]').exists()).toBe(false)
    expect(postJson).not.toHaveBeenCalled()
    await endButton().trigger('click')
    await panel.get('[data-confirm-change]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-spring/retire', { expectedRevision: 6 }]])
    panel.unmount()
  })

  it('removes one word by clicking it; a line\'s only word has no remove button', async () => {
    serve([line({ terms: ['spring-sale', 'coupon'], revision: 7 }),
      line({ assignmentId: 'line-solo', name: 'Solo', terms: ['solo-page'], ownerAgentId: 'fla-orin' })])
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-term="coupon"] [data-remove-term]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-spring/terms',
      { expectedRevision: 7, removeTerms: ['coupon'] }]])
    expect(panel.find('[data-term="solo-page"] [data-remove-term]').exists()).toBe(false)
    panel.unmount()
  })

  it('says once that a two-character word is short, and still lets the person use it', async () => {
    serve([])
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-open-workstream]').trigger('click')
    await panel.get('[data-workstream-words]').setValue('春促页 性能')
    expect(panel.get('[data-short-terms]').text()).toBe(t('projects.workstreams.shortTerms', { terms: '性能' }))
    await panel.get('[data-workstream-words]').setValue('春促页')
    expect(panel.find('[data-short-terms]').exists()).toBe(false)
    panel.unmount()
  })

  it('lists ended lines folded, newest first, without changing them', async () => {
    serve([line()], [{ assignmentId: 'line-old', name: 'Coupon centre', terms: ['coupon'], ownerAgentId: 'fla-orin',
      ownerName: 'Orin Pike', startedAt: '2026-11-01T00:00:00.000Z', endedAt: '2026-11-21T00:00:00.000Z' }])
    const panel = mountPanel()
    await flushPromises()
    const closed = panel.get('[data-workstreams-closed]')
    expect(closed.element.tagName).toBe('DETAILS')
    expect((closed.element as HTMLDetailsElement).open).toBe(false)
    expect(closed.get('summary').text()).toBe(t('projects.workstreams.closed', { count: 1 }))
    expect(closed.text()).toContain('Coupon centre')
    expect(closed.text()).toContain('Orin Pike')
    expect(closed.find('button').exists()).toBe(false)
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

  async function refuseOwnerChange(code: string) {
    serve([line({ revision: 3 })])
    postJson.mockRejectedValueOnce(refused(code))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-workstream] select.project-workstreams-owner').setValue('fla-orin')
    await flushPromises()
    return panel
  }

  async function refuseNewLine(code: string) {
    serve([line()])
    postJson.mockRejectedValueOnce(refused(code))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-open-workstream]').trigger('click')
    await panel.get('[data-workstream-name]').setValue('Autumn sale')
    await panel.get('[data-workstream-words]').setValue('autumn-sale')
    await panel.get('.project-workstreams-form select').setValue('fla-orin')
    await panel.get('.project-workstreams-form').trigger('submit')
    await flushPromises()
    return panel
  }

  it.each(['standing_assignment_term_taken', 'standing_assignment_term_too_broad'])(
    'a refused word (%s) takes the person back to the draft\'s words', async (code) => {
      const panel = await refuseNewLine(code)
      const notice = panel.get('[data-workstreams-problem]')
      expect(notice.text()).toContain(t(`projects.workstreams.problems.${code}`))
      expect(notice.findAll('button').map(button => button.text())).toEqual([t('projects.workstreams.changeWords')])
      await notice.get('[data-change-words]').trigger('click')
      await flushPromises()
      expect(panel.find('[data-workstreams-problem]').exists()).toBe(false)
      // The draft is kept as typed, with the cursor in its words.
      expect((panel.get('[data-workstream-name]').element as HTMLInputElement).value).toBe('Autumn sale')
      expect(document.activeElement).toBe(panel.get('[data-workstream-words]').element)
      panel.unmount()
    })

  it('an owner who is the lead is refused with a member to pick instead', async () => {
    const panel = await refuseOwnerChange('workstream_owner_is_lead')
    const notice = panel.get('[data-workstreams-problem]')
    expect(notice.text()).toContain(t('projects.workstreams.problems.workstream_owner_is_lead'))
    expect(notice.findAll('button').map(button => button.text())).toEqual([t('projects.workstreams.pickAnother')])
    await notice.get('[data-pick-another]').trigger('click')
    expect(panel.find('[data-workstreams-problem]').exists()).toBe(false)
    expect(panel.find('[data-workstream] select.project-workstreams-owner').exists()).toBe(true)
    panel.unmount()
  })

  it('an owner no longer on the project links to the team settings', async () => {
    const panel = await refuseOwnerChange('workstream_owner_not_in_project')
    const notice = panel.get('[data-workstreams-problem]')
    expect(notice.text()).toContain(t('projects.workstreams.problems.workstream_owner_not_in_project'))
    const link = notice.getComponent(RouterLinkStub)
    expect(link.text()).toBe(t('projects.workstreams.openTeam'))
    expect(link.props('to')).toEqual({ path: '/project-agents/manage', query: { project: 'project-a' } })
    expect(notice.find('[data-try-again]').exists()).toBe(false)
    panel.unmount()
  })

  it('a line changed elsewhere is retried at the revision read since', async () => {
    serve([line({ revision: 3 })])
    postJson.mockRejectedValueOnce(refused('standing_assignment_changed'))
    const panel = mountPanel()
    await flushPromises()
    serve([line({ revision: 4 })])
    await panel.get('[data-workstream] select.project-workstreams-owner').setValue('fla-orin')
    await flushPromises()
    const notice = panel.get('[data-workstreams-problem]')
    expect(notice.text()).toContain(t('projects.workstreams.problems.standing_assignment_changed'))
    await notice.get('[data-try-again]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls).toEqual([
      ['/api/standing-assignments/line-spring/reassign', { expectedRevision: 3, projectId: 'project-a', leadAgentId: 'fla-orin' }],
      ['/api/standing-assignments/line-spring/reassign', { expectedRevision: 4, projectId: 'project-a', leadAgentId: 'fla-orin' }],
    ])
    expect(panel.find('[data-workstreams-problem]').exists()).toBe(false)
    panel.unmount()
  })

  it('any other refusal retries the same change: an end, once confirmed, is not asked again', async () => {
    serve([line({ revision: 6 })])
    postJson.mockRejectedValueOnce(new Error('offline'))
    const panel = mountPanel()
    await flushPromises()
    await panel.get(`[aria-label="${t('projects.workstreams.end', { name: 'Spring sale page' })}"]`).trigger('click')
    await panel.get('[data-confirm-change]').trigger('click')
    await flushPromises()
    const notice = panel.get('[data-workstreams-problem]')
    expect(notice.text()).toContain(t('projects.workstreams.problems.failed'))
    expect(notice.get('[data-try-again]').text()).toBe(t('projects.overview.retry'))
    await notice.get('[data-try-again]').trigger('click')
    await flushPromises()
    expect(panel.find('[data-workstream-confirm]').exists()).toBe(false)
    expect(postJson.mock.calls).toEqual([['/api/standing-assignments/line-spring/retire', { expectedRevision: 6 }],
      ['/api/standing-assignments/line-spring/retire', { expectedRevision: 6 }]])
    panel.unmount()
  })

  it('a refused split is sent again from the draft, at the line\'s revision read since', async () => {
    serve([line({ terms: ['spring-sale', 'coupon'], revision: 4 })])
    postJson.mockRejectedValueOnce(refused('standing_assignment_changed'))
    const panel = mountPanel()
    await flushPromises()
    await panel.get('[data-split-workstream]').trigger('click')
    await panel.get('[data-term-chip="coupon"]').trigger('click')
    await panel.get('[data-workstream-name]').setValue('Coupon centre')
    await panel.get('.project-workstreams-form select').setValue('fla-orin')
    serve([line({ terms: ['spring-sale', 'coupon'], revision: 5 })])
    await panel.get('.project-workstreams-form').trigger('submit')
    await flushPromises()
    await panel.get('[data-try-again]').trigger('click')
    await flushPromises()
    expect(postJson.mock.calls.map(([, body]) => body.expectedRevision)).toEqual([4, 5])
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
    const notice = remote.get('[data-workstreams-local-only]')
    expect(notice.text()).toBe(t('projects.workstreams.localOnly'))
    expect(notice.text()).toContain('运行 FULI 的那台电脑')
    expect(notice.attributes('data-no-action')).toBeTruthy()
    expect(remote.find('[data-workstream]').exists()).toBe(false)
    remote.unmount()
  })
})
