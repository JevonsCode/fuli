import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson }))

import ProjectAgentAutomationPolicyPanel from './ProjectAgentAutomationPolicyPanel.vue'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'

describe('ProjectAgentAutomationPolicyPanel', () => {
  it('keeps loading visible while the policy disclosure is collapsed', async () => {
    let finish!: (value: unknown) => void
    getJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const wrapper = mountPanel()
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('summary').text()).toContain(t('projectAgents.coordination.loading'))
    finish({ auto_reuse_previous_agent: true })
    await flushPromises()
    expect(wrapper.get('summary').text()).not.toContain(t('projectAgents.coordination.loading'))
    wrapper.unmount()
  })
  it('does not overwrite the next project when a previous save arrives late', async () => {
    let finish!: (value: unknown) => void
    patchJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const wrapper = mountPanel()
    await flushPromises()
    await switchFor(wrapper, 'projectAgents.coordination.autoReuse').trigger('click')
    await wrapper.setProps({ personalProjectId: 'project-b' })
    await flushPromises()
    finish({ autoReusePreviousAgent: false })
    await flushPromises()
    expect(switchFor(wrapper, 'projectAgents.coordination.autoReuse').attributes('aria-checked')).toBe('true')
  })
  it('disables writes when the policy could not be read', async () => {
    getJson.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.findAll('[role="switch"]').every(input => input.attributes('disabled') !== undefined)).toBe(true)
  })
  beforeEach(() => {
    getJson.mockReset()
    patchJson.mockReset()
    getJson.mockResolvedValue({
      personal_space_id: 'personal-1',
      personal_project_id: 'activity-intake',
      ask_before_recruitment: true,
      auto_reuse_previous_agent: true,
    })
    patchJson.mockImplementation(async (_url: string, input: Record<string, unknown>) => input)
  })

  it('collapses the settings into a one-line summary until opened', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const disclosure = wrapper.get<HTMLDetailsElement>('.project-agent-policy-disclosure')
    expect(disclosure.element.open).toBe(false)
    const summary = wrapper.get('[data-policy-summary]').text()
    expect(summary).toContain(`${t('projectAgents.coordination.autoReuse')} ${t('projectAgents.coordination.on')}`)
    expect(summary).toContain(t('projectAgents.team.lead'))
  })

  it('opens the settings when the policy cannot be read so the error is visible', async () => {
    getJson.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.get<HTMLDetailsElement>('.project-agent-policy-disclosure').element.open).toBe(true)
  })

  it('loads the project switches on by default', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith(
      '/api/project-agent-coordination-policy?personalSpaceId=personal-1&personalProjectId=activity-intake',
    )
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(3)
    expect(wrapper.findAll('[role="switch"]').every(
      sw => sw.attributes('aria-checked') === 'true',
    )).toBe(true)
  })

  it('persists manual @Agent mode without changing the recruitment switch', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    await switchFor(wrapper, 'projectAgents.coordination.autoReuse').trigger('click')
    await flushPromises()

    expect(patchJson).toHaveBeenCalledWith('/api/project-agent-coordination-policy', {
      personalSpaceId: 'personal-1',
      personalProjectId: 'activity-intake',
      askBeforeRecruitment: true,
      autoReusePreviousAgent: false,
      autoGrowTeam: true,
      expectedUpdatedAt: null,
    })
  })

  it('rolls back a failed update and offers a clear error', async () => {
    patchJson.mockRejectedValueOnce(new Error('策略暂时无法保存'))
    const wrapper = mountPanel()
    await flushPromises()

    const reuseSwitch = switchFor(wrapper, 'projectAgents.coordination.autoReuse')
    await reuseSwitch.trigger('click')
    await flushPromises()

    expect(reuseSwitch.attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[role="alert"]').text()).toContain('策略暂时无法保存')
  })

  it('can disable automatic team growth without changing selection or recruitment', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await switchFor(wrapper, 'projectAgents.team.autoGrow').trigger('click')
    await flushPromises()
    expect(patchJson.mock.lastCall?.[1]).toMatchObject({ autoGrowTeam: false,
      autoReusePreviousAgent: true, askBeforeRecruitment: true })
  })

  it('lets the user remove a missing member without dropping a healthy member', async () => {
    getJson.mockResolvedValueOnce({ teamLeadAgentId: 'lead', teamMemberAgentIds: ['member', 'missing'],
      updatedAt: '2026-09-16T00:00:00Z' })
    const wrapper = mountPanel([agent('lead'), agent('member'), agent('temporary', 'temporary')])
    await flushPromises()
    expect(wrapper.findAll('option').some(option => option.attributes('value') === 'temporary')).toBe(false)
    expect(wrapper.findAll('fieldset input').map(input => input.attributes('value'))).not.toContain('temporary')
    await wrapper.get('.unavailable-team-member input').setValue(false)
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(patchJson.mock.lastCall?.[1]).toMatchObject({ teamLeadAgentId: 'lead',
      teamMemberAgentIds: ['member'], expectedUpdatedAt: '2026-09-16T00:00:00Z' })
  })

  it('groups members under a sub-lead and saves the groups with the team', async () => {
    getJson.mockResolvedValueOnce({ teamLeadAgentId: 'lead', teamMemberAgentIds: ['backend', 'engineer', 'designer'],
      updatedAt: '2026-10-18T00:00:00Z' })
    const wrapper = mountPanel([agent('lead'), agent('backend'), agent('engineer'), agent('designer')])
    await flushPromises()
    await wrapper.get('[data-sub-team-add]').trigger('click')
    const row = wrapper.get('[data-sub-team-row]')
    // A group needs a name and a sub-lead before the team can be saved.
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined()
    await row.get('.sub-team-name').setValue('后端')
    // The newest choice on the panel is the group's sub-lead.
    const subLead = wrapper.findAllComponents({ name: 'OptionCombobox' }).at(-1)!
    subLead.vm.$emit('update:modelValue', 'backend')
    await flushPromises()
    await row.findAll('.sub-team-members input').find(input => input.attributes('value') === 'engineer')!.setValue(true)
    expect(row.findAll('.sub-team-members input').map(input => input.attributes('value'))).not.toContain('backend')
    expect(saveButton(wrapper).attributes('disabled')).toBeUndefined()
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(patchJson.mock.lastCall?.[1]).toMatchObject({ teamLeadAgentId: 'lead', expectedUpdatedAt: '2026-10-18T00:00:00Z',
      subTeams: [{ name: '后端', leadAgentId: 'backend', memberAgentIds: ['engineer'] }] })
  })

  it('drops a promoted member from the group so the lead is never also a member', async () => {
    getJson.mockResolvedValueOnce({ teamLeadAgentId: 'lead', teamMemberAgentIds: ['backend', 'engineer', 'designer'],
      subTeams: [{ id: 'group-a', name: '后端', leadAgentId: 'backend', memberAgentIds: ['engineer', 'designer'] }] })
    const wrapper = mountPanel([agent('lead'), agent('backend'), agent('engineer'), agent('designer')])
    await flushPromises()
    const row = wrapper.get('[data-sub-team-row]')
    const subLead = wrapper.findAllComponents({ name: 'OptionCombobox' }).at(-1)!
    subLead.vm.$emit('update:modelValue', 'engineer')
    await flushPromises()
    // The former lead can step down into the same group in the same edit.
    await row.findAll('.sub-team-members input').find(input => input.attributes('value') === 'backend')!.setValue(true)
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(patchJson.mock.lastCall?.[1]).toMatchObject({
      subTeams: [{ id: 'group-a', leadAgentId: 'engineer', memberAgentIds: ['designer', 'backend'] }] })
  })

  it('moves a member between groups once they leave the first group', async () => {
    getJson.mockResolvedValueOnce({ teamLeadAgentId: 'lead', teamMemberAgentIds: ['backend', 'engineer', 'designer', 'writer'],
      subTeams: [{ id: 'group-a', name: '后端', leadAgentId: 'backend', memberAgentIds: ['engineer'] },
        { id: 'group-b', name: '设计', leadAgentId: 'designer', memberAgentIds: [] }] })
    const wrapper = mountPanel([agent('lead'), agent('backend'), agent('engineer'), agent('designer'), agent('writer')])
    await flushPromises()
    const [first, second] = wrapper.findAll('[data-sub-team-row]')
    const memberValues = (row: typeof first) => row.findAll('.sub-team-members input').map(input => input.attributes('value'))
    expect(memberValues(second)).not.toContain('engineer')
    await first.findAll('.sub-team-members input').find(input => input.attributes('value') === 'engineer')!.setValue(false)
    await second.findAll('.sub-team-members input').find(input => input.attributes('value') === 'engineer')!.setValue(true)
    expect(memberValues(first)).not.toContain('engineer')
    await saveButton(wrapper).trigger('click')
    await flushPromises()
    expect(patchJson.mock.lastCall?.[1]).toMatchObject({ subTeams: [
      { id: 'group-a', leadAgentId: 'backend', memberAgentIds: [] },
      { id: 'group-b', leadAgentId: 'designer', memberAgentIds: ['engineer'] }] })
  })

  it('does not offer an empty lead once the project has a lead', async () => {
    getJson.mockResolvedValueOnce({ teamLeadAgentId: 'lead', teamMemberAgentIds: ['member'] })
    const wrapper = mountPanel([agent('lead'), agent('member')])
    await flushPromises()
    expect(wrapper.findAll('option').some(option => option.attributes('value') === '')).toBe(false)
  })
})

function mountPanel(agents?: ProjectAgentRecord[]) {
  return mount(ProjectAgentAutomationPolicyPanel, {
    props: {
      personalSpaceId: 'personal-1',
      personalProjectId: 'activity-intake',
      projectName: '活动承接',
      agents,
    },
  })
}

function saveButton(wrapper: ReturnType<typeof mountPanel>) {
  return wrapper.findAll('button').find(button => button.text() === t('projectAgents.team.save'))!
}

function switchFor(wrapper: ReturnType<typeof mountPanel>, key: string) {
  return wrapper.findAll('label').find(label => label.text().includes(t(key)))!.get('[role="switch"]')
}

function agent(id: string, agentType: 'durable' | 'temporary' = 'durable'): ProjectAgentRecord {
  return { agentId: id, personalSpaceId: 'personal-1', createdAt: '', updatedAt: '',
    profile: { name: id, responsibility: 'Synthetic role', status: 'active', agentType,
      capabilities: [], initialPreferences: [] }, assignments: [{ assignmentId: `assignment-${id}`,
      personalSpaceId: 'personal-1', personalProjectId: 'activity-intake', agentId: id,
      responsibility: 'Synthetic project role', status: 'active', assignedAt: '', updatedAt: '' }] }
}
