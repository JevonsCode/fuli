import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import ModelKeyEntry from './ModelKeyEntry.vue'

// Synthetic key only. The field is write-only: the page learns that a key is
// saved under a reference, never the key.
const SYNTHETIC_KEY = 'sk-synthetic-NEVER-SHOWN-7'

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  api.getJson.mockReset().mockResolvedValue({ saved: ['other'] })
  api.putJson.mockReset()
})

describe('ModelKeyEntry', () => {
  it('saves a key under its reference, empties the field and shows only that it is saved', async () => {
    const wrapper = mount(ModelKeyEntry, { props: { reference: ' deepseek ' } })
    await flushPromises()
    expect(api.getJson).toHaveBeenCalledWith('/api/model-backends/keys')
    expect(wrapper.get('[data-model-key-state]').text()).toBe('「deepseek」还没有保存密钥。')
    expect(wrapper.text()).not.toMatch(/fuli |终端/)

    await wrapper.get('[data-model-key]').setValue(SYNTHETIC_KEY)
    expect(wrapper.get('[data-model-key]').attributes('type')).toBe('password')
    api.putJson.mockResolvedValueOnce({ reference: 'deepseek', saved: true })
    await wrapper.get('[data-model-key-save]').trigger('click')
    await flushPromises()

    expect(api.putJson).toHaveBeenCalledWith('/api/model-backends/keys/deepseek', { key: SYNTHETIC_KEY })
    expect((wrapper.get('[data-model-key]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.get('[data-model-key-state]').text()).toBe('「deepseek」已保存密钥。')
    expect(wrapper.get('[data-model-key-save]').text()).toBe('替换密钥')
    expect(wrapper.html()).not.toContain(SYNTHETIC_KEY)
  })

  it('asks for a usable reference before a key can be saved, and says why a save was refused', async () => {
    const wrapper = mount(ModelKeyEntry, { props: { reference: 'bad ref' } })
    await flushPromises()
    expect(wrapper.get('[data-model-key-state]').text()).toContain('先填密钥引用')
    expect(wrapper.get('[data-model-key]').attributes('disabled')).toBeDefined()

    await wrapper.setProps({ reference: 'local-ref' })
    await wrapper.get('[data-model-key]').setValue(SYNTHETIC_KEY)
    api.putJson.mockRejectedValueOnce(new Error('The key must be one line'))
    await wrapper.get('[data-model-key-save]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('The key must be one line')
    expect((wrapper.get('[data-model-key]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.html()).not.toContain(SYNTHETIC_KEY)
  })
})
