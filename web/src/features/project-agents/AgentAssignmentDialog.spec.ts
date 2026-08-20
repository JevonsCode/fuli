import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ postJson }))

import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import type { PersonalProject, ProjectAgentAssignmentRecord, ProjectAgentRecord } from '@/types'
import AgentAssignmentDialog from './AgentAssignmentDialog.vue'

const agent: ProjectAgentRecord = {
  agentId: 'activity-agent',
  personalSpaceId: 'personal-1',
  personalProjectId: 'project-a',
  profile: {
    name: '活动 Agent',
    responsibility: '负责活动方案与复盘。',
    capabilities: [],
    initialPreferences: [],
    status: 'active',
  },
  createdAt: '2026-08-17T00:00:00Z',
  updatedAt: '2026-08-17T00:00:00Z',
}

const projects: PersonalProject[] = [{
  project_id: 'project-a',
  personal_space_id: 'personal-1',
  profile: { name: '活动项目', sources: [], boundaries: [] },
}, {
  project_id: 'project-b',
  personal_space_id: 'personal-1',
  profile: { name: '设计项目', sources: [], boundaries: [] },
}]

const assignment: ProjectAgentAssignmentRecord = {
  assignmentId: 'assignment-a',
  personalSpaceId: 'personal-1',
  personalProjectId: 'project-a',
  agentId: 'activity-agent',
  responsibility: '负责活动方案与复盘。',
  status: 'active',
  assignedAt: '2026-08-17T00:00:00Z',
  updatedAt: '2026-08-17T00:00:00Z',
}

describe('AgentAssignmentDialog', () => {
  beforeEach(() => {
    postJson.mockReset()
    postJson.mockResolvedValue(assignment)
  })

  it('creates a project assignment with an idempotent API payload', async () => {
    const wrapper = mountDialog()
    await wrapper.get('[aria-label="所属项目"]').setValue('project-b')
    await wrapper.get('textarea').setValue('负责设计复盘')
    await wrapper.findAll('textarea')[2].setValue('设计职责')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/project-agent-assignments', expect.objectContaining({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-b',
      agentId: 'activity-agent',
      responsibility: '负责设计复盘',
      reason: '设计职责',
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('ends an assignment with a required reason', async () => {
    const wrapper = mountDialog({ action: 'end', assignment })
    await wrapper.get('textarea').setValue('职责完成')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/project-agent-assignments/assignment-a/end', expect.objectContaining({
      assignmentId: 'assignment-a',
      expectedRevision: 0,
      reason: '职责完成',
    }))
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('requires a real replacement Agent before replacing an assignment', async () => {
    const wrapper = mountDialog({
      action: 'replace',
      assignment,
    })
    await wrapper.get('textarea').setValue('改由另一个 Agent 负责')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('请选择替换 Agent')
    expect(postJson).not.toHaveBeenCalled()
  })

  it('uses the audited replace endpoint with the current revision', async () => {
    const replacement: ProjectAgentRecord = {
      ...agent,
      agentId: 'replacement-agent',
      profile: { ...agent.profile, name: '替换 Agent' },
    }
    const wrapper = mountDialog({
      action: 'replace',
      assignment: { ...assignment, revision: 3 },
      availableAgents: [agent, replacement],
    })
    await wrapper.get('[aria-label="替换为"]').setValue('replacement-agent')
    await wrapper.get('textarea').setValue('改由另一个 Agent 负责')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/project-agent-assignments/assignment-a/replace', expect.objectContaining({
      assignmentId: 'assignment-a',
      expectedRevision: 3,
      replacementAgentId: 'replacement-agent',
    }))
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('uses the native modal focus lifecycle', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open assignment dialog'
    document.body.append(trigger)
    trigger.focus()
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const wrapper = mount(AgentAssignmentDialog, {
      attachTo: document.body,
      props: {
        open: false,
        agent,
        projects,
        defaultProjectId: 'project-a',
      },
      global: { stubs: { SearchableSelect: SearchableSelectStub } },
    })

    await wrapper.setProps({ open: true })
    await flushPromises()

    const dialog = wrapper.get('dialog')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(dialog.get('[data-dialog-initial-focus]').element)

    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    showModal.mockRestore()
  })
})

function mountDialog(options: { action?: 'assign' | 'end' | 'replace'; assignment?: ProjectAgentAssignmentRecord; availableAgents?: ProjectAgentRecord[] } = {}) {
  return mount(AgentAssignmentDialog, {
    props: {
      open: true,
      agent,
      projects,
      defaultProjectId: 'project-a',
      ...options,
    },
    global: { stubs: { SearchableSelect: SearchableSelectStub } },
  })
}
