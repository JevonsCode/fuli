import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const putJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ putJson }))

import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import type { PersonalProject, ProjectAgentExecutorRef } from '@/types'
import ExecutorRoutingDialog from './ExecutorRoutingDialog.vue'

const projects: PersonalProject[] = [{
  project_id: 'project-a', personal_space_id: 'personal-1',
  profile: { name: '活动项目', sources: [], boundaries: [] },
}]

const executor: ProjectAgentExecutorRef = {
  executorId: 'executor-codex', displayName: 'Codex 执行器', executorKind: 'external',
  capabilities: ['review'], globalPriority: 12, revision: 4,
  registrationStatus: 'registered', permissionStatus: 'authorized',
  preflightStatus: 'passed', healthStatus: 'healthy',
}

describe('ExecutorRoutingDialog', () => {
  beforeEach(() => {
    putJson.mockReset()
    putJson.mockImplementation((url: string) => Promise.resolve(url.includes('routing-rules')
      ? { ruleId: 'rule-1', scope: 'project', priority: 20, workKind: 'review', enabled: true }
      : executor))
  })

  it('registers or edits an executor with revision and observed-state-safe fields', async () => {
    const wrapper = mount(ExecutorRoutingDialog, {
      props: { open: true, mode: 'executor', personalSpaceId: 'personal-1', executor, projects },
    })
    await wrapper.get('input[type="number"]').setValue('7')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/executors', expect.objectContaining({
      personalSpaceId: 'personal-1', executorId: 'executor-codex',
      globalPriority: 7, expectedRevision: 4,
    }))
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('creates a project work-kind routing rule with explicit executor IDs', async () => {
    const wrapper = mount(ExecutorRoutingDialog, {
      props: {
        open: true, mode: 'rule', personalSpaceId: 'personal-1', projects,
        availableExecutors: [executor],
      },
      global: { stubs: { SearchableSelect: SearchableSelectStub } },
    })
    await wrapper.get('select').setValue('project')
    await wrapper.get('[aria-label="所属项目"]').setValue('project-a')
    await wrapper.findAll('input')[1].setValue('review')
    await wrapper.get('textarea').setValue('executor-codex')
    await wrapper.findAll('textarea')[2].setValue('工作范围已明确')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/executor-routing-rules', expect.objectContaining({
      personalSpaceId: 'personal-1', scope: 'project', personalProjectId: 'project-a',
      workKind: 'review', executorIds: ['executor-codex'], reason: '工作范围已明确',
    }))
  })

  it('uses the native modal focus lifecycle', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open executor dialog'
    document.body.append(trigger)
    trigger.focus()
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const wrapper = mount(ExecutorRoutingDialog, {
      attachTo: document.body,
      props: {
        open: false,
        mode: 'executor',
        personalSpaceId: 'personal-1',
        projects,
      },
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
