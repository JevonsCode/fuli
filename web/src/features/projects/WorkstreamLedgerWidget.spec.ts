import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (actual) => ({ ...(await actual<typeof import('@/api/client')>()), getJson, postJson: vi.fn() }))

import WorkstreamLedgerWidget from './WorkstreamLedgerWidget.vue'
import { ApiError } from '@/api/client'
import { setLocale, t } from '@/i18n'
import type { AgentWorkstreamLedger } from './project-team-api'

// The widget reads its own data from the FLA of wherever it sits, and one row
// says which project, which line, who and how far. Fictional people only.

const ledger: AgentWorkstreamLedger = {
  agentId: 'fla-mara',
  projects: [{
    projectId: 'project-a', projectName: 'Campaigns', leads: true,
    workstreams: [{
      assignmentId: 'line-spring', name: 'Spring sale page', terms: ['spring-sale'],
      ownerAgentId: 'fla-ember', ownerName: 'Ember Vale', ownerOnProject: true, decidedBy: 'host',
      startedAt: '2026-11-20T00:00:00.000Z', changedAt: '2026-11-20T00:00:00.000Z', revision: 1,
      latestTask: { status: 'running', summary: 'New hero image', at: '2026-11-23T02:00:00.000Z' },
    }, {
      assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'],
      ownerAgentId: 'fla-former', ownerName: 'Fern Holt', ownerOnProject: false, decidedBy: 'user',
      startedAt: '2026-11-21T00:00:00.000Z', changedAt: '2026-11-21T00:00:00.000Z', revision: 1,
      latestTask: null,
    }],
  }],
}

function mountWidget() {
  return mount(WorkstreamLedgerWidget, { attachTo: document.body,
    props: { spaceId: 'space-1', agentId: 'fla-mara' },
    global: { stubs: { RouterLink: RouterLinkStub } } })
}

describe('WorkstreamLedgerWidget', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
  })

  it('reads its own data for the FLA it sits with', async () => {
    getJson.mockResolvedValue(ledger)
    const widget = mountWidget()
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/workstreams?agentId=fla-mara', expect.anything())
    expect(widget.get('[data-ledger-project="project-a"]').text()).toContain('Campaigns')
    widget.unmount()
  })

  it('each row says which line, who and how far; an owner who left is marked', async () => {
    getJson.mockResolvedValue(ledger)
    const widget = mountWidget()
    await flushPromises()
    const rows = widget.findAll('[data-ledger-workstream]')
    expect(rows[0].text()).toContain('Spring sale page')
    expect(rows[0].text()).toContain('Ember Vale')
    expect(rows[0].text()).toContain('New hero image')
    expect(rows[0].find('[data-owner-gone]').exists()).toBe(false)
    expect(rows[1].text()).toContain(t('projects.workstreams.noTask'))
    expect(rows[1].get('[data-owner-gone]').text()).toBe(t('projects.workstreams.ownerLeft'))
    widget.unmount()
  })

  it('shows nothing at all when this FLA has no lines', async () => {
    getJson.mockResolvedValue({ agentId: 'fla-mara', projects: [] })
    const widget = mountWidget()
    await flushPromises()
    expect(widget.find('[data-workstream-ledger]').exists()).toBe(false)
    widget.unmount()
  })

  it('over the LAN it says the ledger is read only here, without a retry that cannot work', async () => {
    getJson.mockRejectedValue(new ApiError('no', 403, JSON.stringify({ code: 'local_user_only' })))
    const widget = mountWidget()
    await flushPromises()
    const notice = widget.get('[data-ledger-local-only]')
    // Nothing here can open it: the notice names where to go, and says so on itself.
    expect(notice.text()).toBe(t('projects.workstreams.localOnly'))
    expect(notice.text()).toContain('运行 FULI 的那台电脑')
    expect(notice.attributes('data-no-action')).toBeTruthy()
    expect(widget.find('button').exists()).toBe(false)
    widget.unmount()
  })

  it('another failure says so and retries', async () => {
    getJson.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ledger)
    const widget = mountWidget()
    await flushPromises()
    expect(widget.text()).toContain(t('projects.workstreams.failed'))
    await widget.get('button').trigger('click')
    await flushPromises()
    expect(widget.findAll('[data-ledger-workstream]')).toHaveLength(2)
    widget.unmount()
  })
})
