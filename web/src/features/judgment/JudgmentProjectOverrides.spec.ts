import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson }))

import type { PersonalProject } from '@/types'
import JudgmentProjectOverrides from './JudgmentProjectOverrides.vue'

const base = { quality: 'quality', client: 'claude_code', globalRevision: 2 }
const defaultPolicy = { ...base, mode: 'shared', revision: 2, inherited: false, personalProjectId: null }
const ledgerOverride = { ...base, mode: 'autonomous', revision: 1, inherited: false, personalProjectId: 'ledger' }
const projects = [
  { project_id: 'ledger', personal_space_id: 'space', profile: { name: '家庭账本' } },
  { project_id: 'novel', personal_space_id: 'space', profile: { name: '小说连载' } },
  { project_id: 'other', personal_space_id: 'space-b', profile: { name: '别人的项目' } },
] as PersonalProject[]

describe('JudgmentProjectOverrides', () => {
  beforeEach(() => {
    getJson.mockReset().mockImplementation(async (url: string) => url.startsWith('/api/judgment/policies')
      ? { default: defaultPolicy, overrides: [ledgerOverride] }
      : { ...defaultPolicy, inherited: true, revision: 3, personalProjectId: 'novel' })
    putJson.mockReset().mockImplementation(async (_url: string, body: { personalProjectId: string, policy: Record<string, string> | null, expectedRevision: number }) => body.policy
      ? { ...base, ...body.policy, inherited: false, revision: body.expectedRevision + 1, personalProjectId: body.personalProjectId }
      : { ...defaultPolicy, inherited: true, revision: body.expectedRevision + 1, personalProjectId: body.personalProjectId })
  })

  it('lists each project with its own judgment, adds one from the default and drops one that returns to it', async () => {
    const wrapper = mount(JudgmentProjectOverrides, { props: { personalSpaceId: 'space', projects } })
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/judgment/policies?personalSpaceId=space', expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.get('[data-judgment-default]').text()).toMatch(/共同决策|Shared/)
    const rows = () => wrapper.findAll('[data-project-judgment]').map(row => row.attributes('data-project-judgment'))
    expect(rows()).toEqual(['ledger'])
    expect(wrapper.get('[data-project-judgment="ledger"]').text()).toContain('家庭账本')
    // Only this space's projects without their own policy can be added.
    const choices = wrapper.getComponent({ name: 'OptionCombobox' }).props('options').map((option: { label: string }) => option.label)
    expect(choices).toEqual(['小说连载'])

    await wrapper.get('[data-action="add-project-policy"]').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/judgment/policy?personalSpaceId=space&personalProjectId=novel', expect.objectContaining({ schema: expect.anything() }))
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', { personalSpaceId: 'space', personalProjectId: 'novel',
      policy: { mode: 'shared', quality: 'quality', client: 'claude_code' }, expectedRevision: 3 }, expect.objectContaining({ schema: expect.anything() }))
    expect(rows()).toEqual(['ledger', 'novel'])
    expect(wrapper.find('[data-select="judgment-override-project"]').exists()).toBe(false)

    await wrapper.get('[data-project-judgment="ledger"] [data-action="reset-project-policy"]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', { personalSpaceId: 'space', personalProjectId: 'ledger', policy: null, expectedRevision: 1 }, expect.objectContaining({ schema: expect.anything() }))
    expect(rows()).toEqual(['novel'])
  })
})
