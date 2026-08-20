import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const putJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ putJson, postJson }))

import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import type { PersonalProject, ProjectAgentRecord } from '@/types'
import ProjectAgentDialog from './ProjectAgentDialog.vue'

const projects: PersonalProject[] = [{
  project_id: 'project-a',
  personal_space_id: 'personal-1',
  profile: { name: '活动项目', sources: [], boundaries: [] },
}]

const savedAgent: ProjectAgentRecord = {
  agentId: 'activity-agent',
  personalSpaceId: 'personal-1',
  personalProjectId: 'project-a',
  profile: {
    name: '活动 Agent',
    responsibility: '负责活动方案与复盘。',
    capabilities: ['活动策划', '活动复盘'],
    initialPreferences: ['先给结论'],
    status: 'active',
  },
  createdAt: '2026-08-17T00:00:00Z',
  updatedAt: '2026-08-17T00:00:00Z',
}

describe('ProjectAgentDialog', () => {
  beforeEach(() => {
    putJson.mockReset()
    postJson.mockReset()
    putJson.mockResolvedValue(savedAgent)
    postJson.mockResolvedValue({
      assignmentId: 'assignment-a',
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      agentId: 'activity-agent',
      responsibility: '负责活动方案与复盘。',
      status: 'active',
      assignedAt: '2026-08-17T00:00:00Z',
      updatedAt: '2026-08-17T00:00:00Z',
    })
  })

  it('creates a project Agent with the exact facade payload', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[name="project-agent-id"]').setValue(' activity-agent ')
    await wrapper.get('[name="project-agent-name"]').setValue(' 活动 Agent ')
    await wrapper.get('[name="project-agent-responsibility"]')
      .setValue(' 负责活动方案与复盘。 ')
    await wrapper.get('[name="project-agent-capabilities"]')
      .setValue('活动策划\n活动复盘')
    await wrapper.get('[name="project-agent-preferences"]').setValue('先给结论')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/project-agents', {
      personalSpaceId: 'personal-1',
      personalProjectId: null,
      agentId: 'activity-agent',
      profile: {
        name: '活动 Agent',
        responsibility: '负责活动方案与复盘。',
        capabilities: ['活动策划', '活动复盘'],
        initialPreferences: ['先给结论'],
        status: 'active',
      },
    })
    expect(postJson).toHaveBeenCalledWith('/api/project-agent-assignments', expect.objectContaining({
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      agentId: 'activity-agent',
    }))
    expect(wrapper.emitted('saved')?.[0]?.[0]).toMatchObject({
      agentId: savedAgent.agentId,
      personalProjectId: 'project-a',
    })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('persists an occupation emoji separately from the Agent name', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[name="project-agent-id"]').setValue('design-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('设计 Agent')
    await wrapper.get('[name="project-agent-occupation-emoji"]').setValue('🎛️')
    await wrapper.get('[name="project-agent-responsibility"]').setValue('负责界面结构。')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson.mock.calls[0][1].profile).toMatchObject({
      name: '设计 Agent',
      occupationEmoji: '🎛️',
    })
    expect(putJson.mock.calls[0][1].profile.name).not.toContain('🎛️')
  })

  it('rejects non-emoji occupation labels before writing', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[name="project-agent-id"]').setValue('design-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('设计 Agent')
    await wrapper.get('[name="project-agent-occupation-emoji"]').setValue('设计')
    await wrapper.get('[name="project-agent-responsibility"]').setValue('负责界面结构。')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('[role="alert"]').text()).toContain('职业 emoji')
    expect(putJson).not.toHaveBeenCalled()
  })

  it('accepts one long emoji grapheme and rejects multiple emoji graphemes', async () => {
    const wrapper = mountDialog()
    const longSingleEmoji = '👨‍👩‍👧‍👦‍👨‍👩‍👧‍👦'

    await wrapper.get('[name="project-agent-id"]').setValue('emoji-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('Emoji Agent')
    await wrapper.get('[name="project-agent-responsibility"]').setValue('负责 emoji 边界。')
    await wrapper.get('[name="project-agent-occupation-emoji"]').setValue(longSingleEmoji)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson.mock.calls[0][1].profile.occupationEmoji).toBe(longSingleEmoji)

    putJson.mockClear()
    await wrapper.get('[name="project-agent-occupation-emoji"]').setValue('🧱🔌')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('[role="alert"]').text()).toContain('职业 emoji')
    expect(putJson).not.toHaveBeenCalled()
  })

  it('rejects duplicate line items before writing', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[name="project-agent-id"]').setValue('activity-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('活动 Agent')
    await wrapper.get('[name="project-agent-responsibility"]')
      .setValue('负责活动方案与复盘。')
    await wrapper.get('[name="project-agent-capabilities"]')
      .setValue('活动策划\n活动策划')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('[role="alert"]').text()).toContain('不能包含重复项')
    expect(putJson).not.toHaveBeenCalled()
  })

  it('persists an explicit locked executor allow-list without inventing availability', async () => {
    const wrapper = mountDialog()

    await wrapper.get('[name="project-agent-id"]').setValue('activity-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('活动 Agent')
    await wrapper.get('[name="project-agent-responsibility"]')
      .setValue('负责活动方案与复盘。')
    await wrapper.get('[name="project-agent-selection-mode"]').setValue('locked')
    await wrapper.get('[name="project-agent-allow-list"]').setValue('executor-codex\nexecutor-codex')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.get('[role="alert"]').text()).toContain('不能包含重复项')
    expect(putJson).not.toHaveBeenCalled()

    await wrapper.get('[name="project-agent-allow-list"]').setValue('executor-codex')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson.mock.calls[0][1].profile.executorPolicy).toEqual({
      mode: 'locked',
      lockedExecutorIds: ['executor-codex'],
      preferredExecutorIds: [],
    })
  })

  it('locks the stable project and Agent ID while editing', () => {
    const wrapper = mountDialog(savedAgent)

    expect(wrapper.get('[aria-label="所属项目"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[name="project-agent-id"]').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('[name="project-agent-name"]').element).toHaveProperty(
      'value',
      '活动 Agent',
    )
  })

  it('creates a space-level identity without requiring a project', async () => {
    const wrapper = mountDialog(null, { projects: [], defaultProjectId: null, personalSpaceId: 'personal-1' })
    await wrapper.get('[name="project-agent-id"]').setValue('space-agent')
    await wrapper.get('[name="project-agent-name"]').setValue('空间 Agent')
    await wrapper.get('[name="project-agent-responsibility"]').setValue('跨项目协调')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/project-agents', expect.objectContaining({
      personalSpaceId: 'personal-1', personalProjectId: null, agentId: 'space-agent',
    }))
    expect(postJson).not.toHaveBeenCalled()
  })

  it('does not offer temporary or coordinator for direct identity creation', () => {
    const wrapper = mountDialog()
    const values = wrapper.findAll('[name="project-agent-type"] option').map((option) => option.attributes('value'))
    expect(values).toEqual(['durable', 'hr'])
  })

  it('opens as a modal, constrains Tab focus, and restores the trigger', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Open Agent dialog'
    document.body.append(trigger)
    trigger.focus()
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    const wrapper = mount(ProjectAgentDialog, {
      attachTo: document.body,
      props: {
        open: false,
        agent: null,
        projects,
        defaultProjectId: 'project-a',
        personalSpaceId: 'personal-1',
      },
      global: { stubs: { SearchableSelect: SearchableSelectStub } },
    })

    await wrapper.setProps({ open: true })
    await flushPromises()

    const dialog = wrapper.get('dialog')
    const initialFocus = dialog.get('[data-dialog-initial-focus]')
    const submit = dialog.get('button[type="submit"]')
    expect(showModal).toHaveBeenCalledTimes(1)
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(document.activeElement).toBe(initialFocus.element)

    ;(submit.element as HTMLElement).focus()
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(initialFocus.element)

    await dialog.trigger('cancel')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ open: false })
    await flushPromises()
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    showModal.mockRestore()
  })
})

function mountDialog(agent: ProjectAgentRecord | null = null, overrides: Record<string, unknown> = {}) {
  return mount(ProjectAgentDialog, {
    props: {
      open: true,
      agent,
      projects,
      defaultProjectId: 'project-a',
      ...overrides,
    },
    global: { stubs: { SearchableSelect: SearchableSelectStub } },
  })
}
