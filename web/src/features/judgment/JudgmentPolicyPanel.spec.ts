import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson }))

import JudgmentPolicyPanel from './JudgmentPolicyPanel.vue'

const globalPolicy = {
  mode: 'manual' as const,
  quality: 'quality' as const,
  client: 'codex' as const,
  revision: 4,
  globalRevision: 4,
  inherited: false,
  personalProjectId: null,
}

describe('JudgmentPolicyPanel', () => {
  beforeEach(() => {
    getJson.mockReset().mockResolvedValue(globalPolicy)
    putJson.mockReset().mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
      ...globalPolicy,
      ...(body.policy && typeof body.policy === 'object' ? body.policy : {}),
      revision: 5,
      globalRevision: 5,
      personalProjectId: body.personalProjectId ?? null,
    }))
  })

  it('loads the global policy and saves one of the three autonomy modes', async () => {
    const wrapper = mount(JudgmentPolicyPanel, {
      props: { personalSpaceId: 'space-a' },
    })
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/judgment/policy?personalSpaceId=space-a')
    expect(wrapper.findAll('input[type="radio"][name="judgment-mode"]')).toHaveLength(3)

    await wrapper.get('input[type="radio"][value="shared"]').setValue(true)
    await flushPromises()

    expect(putJson).toHaveBeenCalledWith('/api/judgment/policy', {
      personalSpaceId: 'space-a',
      policy: { mode: 'shared', quality: 'quality', client: 'codex' },
      expectedRevision: 4,
    })
  })

  it('uses a project override and can reset it to inherited policy', async () => {
    getJson
      .mockResolvedValueOnce(globalPolicy)
      .mockResolvedValueOnce({ ...globalPolicy, inherited: false, personalProjectId: 'project-a', globalRevision: 4 })
      .mockResolvedValueOnce(globalPolicy)
    const wrapper = mount(JudgmentPolicyPanel, {
      props: {
        personalSpaceId: 'space-a',
        projects: [{ id: 'project-a', name: '验收项目' }],
      },
    })
    await flushPromises()

    await wrapper.get('[data-select="judgment-project"]').setValue('project-a')
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/judgment/policy?personalSpaceId=space-a&personalProjectId=project-a')

    await wrapper.get('[data-action="reset-policy"]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/judgment/policy', {
      personalSpaceId: 'space-a',
      personalProjectId: 'project-a',
      policy: null,
      expectedRevision: 4,
    })
  })

  it('undoes the last autosaved choice using the returned revision', async () => {
    const wrapper = mount(JudgmentPolicyPanel, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('input[type="radio"][value="shared"]').setValue(true)
    await flushPromises()
    await wrapper.get('[data-action="undo-policy"]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', {
      personalSpaceId: 'space-a',
      policy: { mode: 'manual', quality: 'quality', client: 'codex' },
      expectedRevision: 5,
    })
    expect(wrapper.find('[data-action="undo-policy"]').exists()).toBe(false)
  })

  it('reloads after a stale write and presents a meaningful conflict', async () => {
    putJson.mockRejectedValueOnce({ status: 409 })
    getJson
      .mockResolvedValueOnce(globalPolicy)
      .mockResolvedValueOnce({ ...globalPolicy, revision: 5, globalRevision: 5 })
    const wrapper = mount(JudgmentPolicyPanel, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    await wrapper.get('input[type="radio"][value="autonomous"]').setValue(true)
    await flushPromises()

    expect(getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toMatch(/changed|更新|重试/i)
  })

  it('does not call the API while the personal space is unresolved', async () => {
    const wrapper = mount(JudgmentPolicyPanel, { props: { personalSpaceId: '' } })
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(wrapper.find('[data-action="save-policy"]').exists()).toBe(false)
  })
})
