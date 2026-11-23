import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson, postJson: vi.fn() }))

import WorkstreamLedgerWidget from './WorkstreamLedgerWidget.vue'
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
      latestTask: { taskId: 'task-1', title: 'New hero image', status: 'running',
        updatedAt: '2026-11-23T02:00:00.000Z' },
    }, {
      assignmentId: 'line-coupon', name: 'Coupon centre', terms: ['coupon'],
      ownerAgentId: 'fla-orin', ownerName: 'Orin Pike', ownerOnProject: true, decidedBy: 'user',
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

  it('each row says which line, who and how far', async () => {
    getJson.mockResolvedValue(ledger)
    const widget = mountWidget()
    await flushPromises()
    const rows = widget.findAll('[data-ledger-workstream]')
    expect(rows[0].text()).toContain('Spring sale page')
    expect(rows[0].text()).toContain('Ember Vale')
    expect(rows[0].text()).toContain('New hero image')
    // A line with no task yet says so rather than looking finished.
    expect(rows[1].text()).toContain(t('projects.workstreams.noTask'))
    widget.unmount()
  })

  it('shows nothing at all when this FLA has no lines', async () => {
    getJson.mockResolvedValue({ agentId: 'fla-mara', projects: [] })
    const widget = mountWidget()
    await flushPromises()
    expect(widget.find('[data-workstream-ledger]').exists()).toBe(false)
    widget.unmount()
  })

  it('a failed read says so and retries', async () => {
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
