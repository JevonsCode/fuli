import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson }))

import { optionSelectStubs } from '@/test-support/OptionSelectStub'
import ProjectJudgmentPolicy from './ProjectJudgmentPolicy.vue'
import type { JudgmentPolicy } from './judgment-types'

const inherited: JudgmentPolicy = { mode: 'autonomous', quality: 'quality', client: 'claude_code', revision: 0, globalRevision: 3, inherited: true, personalProjectId: 'ledger' }
const props = { personalSpaceId: 'space', projectId: 'ledger', projectName: '家庭账本', heading: 'Tonborg' }
// The policy route answers what the PUT stored: the body's policy, or the default again for null.
const stored = (body: { policy: Record<string, string> | null, expectedRevision: number }) => body.policy
  ? { ...inherited, ...body.policy, inherited: false, revision: body.expectedRevision + 1 }
  : { ...inherited, revision: body.expectedRevision + 1 }

describe('ProjectJudgmentPolicy', () => {
  beforeEach(() => {
    getJson.mockReset().mockResolvedValue(inherited)
    putJson.mockReset().mockImplementation(async (_url: string, body: { policy: Record<string, string> | null, expectedRevision: number }) => stored(body))
  })

  it('shows the default a project uses, gives it its own, changes it and returns it to the default', async () => {
    const wrapper = mount(ProjectJudgmentPolicy, { props, global: { stubs: optionSelectStubs } })
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/judgment/policy?personalSpaceId=space&personalProjectId=ledger')
    expect(wrapper.get('[data-project-judgment-default]').text()).toMatch(/自主处理 · 质量优先 · Claude Code|Autonomous · Quality priority · Claude Code/)

    await wrapper.get('[data-action="start-project-policy"]').trigger('click')
    await flushPromises()
    // It starts from the policy the project used, at the revision just read.
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', { personalSpaceId: 'space', personalProjectId: 'ledger',
      policy: { mode: 'autonomous', quality: 'quality', client: 'claude_code' }, expectedRevision: 0 })
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject({ inherited: false, revision: 1 })

    await wrapper.get('[data-select="judgment-mode"]').setValue('manual')
    await flushPromises()
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', { personalSpaceId: 'space', personalProjectId: 'ledger',
      policy: { mode: 'manual', quality: 'quality', client: 'claude_code' }, expectedRevision: 1 })

    await wrapper.get('[data-action="reset-project-policy"]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenLastCalledWith('/api/judgment/policy', { personalSpaceId: 'space', personalProjectId: 'ledger', policy: null, expectedRevision: 2 })
    expect(wrapper.find('[data-project-judgment-default]').exists()).toBe(true)
  })

  it('names the project in the pending save and keeps one indicator for it', async () => {
    let answer: (value: unknown) => void = () => {}
    putJson.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const wrapper = mount(ProjectJudgmentPolicy, { props: { ...props, policy: { ...inherited, inherited: false, revision: 4 } }, global: { stubs: optionSelectStubs } })
    expect(getJson).not.toHaveBeenCalled()
    await wrapper.get('[data-select="judgment-quality"]').setValue('economy')
    expect(wrapper.get('[data-project-judgment-saving]').text()).toContain('家庭账本')
    expect(wrapper.findAll('[role="status"], .growth-loading').length).toBeLessThanOrEqual(1)
    answer({ ...inherited, quality: 'economy', inherited: false, revision: 5 })
    await flushPromises()
    expect(wrapper.find('[data-project-judgment-saving]').exists()).toBe(false)
  })

  it('reads the policy again after a stale write and says so', async () => {
    putJson.mockRejectedValueOnce({ status: 409 })
    getJson.mockResolvedValueOnce({ ...inherited, inherited: false, revision: 6 })
    const wrapper = mount(ProjectJudgmentPolicy, { props: { ...props, policy: { ...inherited, inherited: false, revision: 5 } }, global: { stubs: optionSelectStubs } })
    await wrapper.get('[data-select="judgment-mode"]').setValue('shared')
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[role="alert"]').text()).toMatch(/更新|changed/)
  })
})
