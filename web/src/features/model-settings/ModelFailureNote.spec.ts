import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ModelFailureNote from './ModelFailureNote.vue'
import { checkModelRole } from './model'

vi.mock('./model', async importOriginal => ({ ...await importOriginal<typeof import('./model')>(), checkModelRole: vi.fn() }))

const mountNote = () => mount(ModelFailureNote, { props: { text: '没回应：密钥不对 · 3小时前', role: 'assistant', model: 'synthetic-chat' } })

describe('ModelFailureNote', () => {
  beforeEach(() => { vi.mocked(checkModelRole).mockReset() })

  it('says what failed as an alert and offers 测试连接 in the same line', () => {
    const wrapper = mountNote()
    expect(wrapper.get('[data-model-failure]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('没回应：密钥不对 · 3小时前')
    expect(wrapper.get('[data-model-check]').text()).toBe('测试连接')
  })

  it('names the test while it runs, then shows the answer in place and tells its owner', async () => {
    let finish: (value: Awaited<ReturnType<typeof checkModelRole>>) => void = () => {}
    vi.mocked(checkModelRole).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const wrapper = mountNote()
    await wrapper.get('[data-model-check]').trigger('click')
    expect(checkModelRole).toHaveBeenCalledWith('assistant')
    expect(wrapper.get('[data-model-check]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-model-check] [role="status"]').attributes('aria-label')).toBe('正在测试 Astro 的模型')
    finish({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-chat' } })
    await flushPromises()
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('连接正常，synthetic-chat 回答了。')
    expect(wrapper.get('[data-model-failure]').attributes('role')).toBe('status')
    expect(wrapper.emitted('checked')).toEqual([[true]])
    // The link stays where it was, to test again.
    expect(wrapper.get('[data-model-check]').text()).toBe('测试连接')
  })

  it('says why the test failed, in plain words', async () => {
    vi.mocked(checkModelRole).mockResolvedValue({ ok: false, receipt: { status: 'failed', reason: 'network' } })
    const wrapper = mountNote()
    await wrapper.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('没有连上：连不到这个地址，看看地址和端口对不对、服务开着没有')
    expect(wrapper.get('[data-model-failure]').attributes('role')).toBe('alert')
    expect(wrapper.emitted('checked')).toEqual([[false]])
  })
})
