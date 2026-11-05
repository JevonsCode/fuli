import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelRoleCheck from './ModelRoleCheck.vue'
import { checkModelRole } from './model'

vi.mock('./model', async importOriginal => ({ ...await importOriginal<typeof import('./model')>(), checkModelRole: vi.fn() }))

describe('ModelRoleCheck', () => {
  beforeEach(() => { vi.mocked(checkModelRole).mockReset() })

  it('says the model answered', async () => {
    vi.mocked(checkModelRole).mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-model' } })
    const wrapper = mount(ModelRoleCheck, { props: { role: 'assistant', model: 'configured-model' } })
    await wrapper.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(checkModelRole).toHaveBeenCalledWith('assistant')
    expect(wrapper.get('[data-model-check-result]').text()).toContain('synthetic-model')
  })

  it('says why it failed', async () => {
    vi.mocked(checkModelRole).mockResolvedValue({ ok: false, receipt: { status: 'failed', reason: 'authentication failed' } })
    const wrapper = mount(ModelRoleCheck, { props: { role: 'assistant', model: 'configured-model' } })
    await wrapper.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-model-check-result]').text()).toContain('authentication failed')
    expect(wrapper.get('[data-model-check-result]').attributes('role')).toBe('alert')
  })
})
