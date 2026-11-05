import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import SemanticIndexProgress from './SemanticIndexProgress.vue'

afterEach(() => { api.getJson.mockReset(); api.postJson.mockReset() })

async function mountProgress(model: string | null, status: unknown) {
  setLocale('zh-CN')
  api.getJson.mockResolvedValue(status)
  api.postJson.mockResolvedValue(status)
  const wrapper = mount(SemanticIndexProgress, { props: { model } })
  await flushPromises()
  return wrapper
}

describe('SemanticIndexProgress', () => {
  it('lights stars for the share done and glows the next one while a pass runs', async () => {
    const wrapper = await mountProgress('synthetic-embed', { model: 'synthetic-embed', total: 48, done: 12, running: true })
    expect(wrapper.text()).toContain('12/48')
    expect(wrapper.findAll('.is-lit')).toHaveLength(6)
    expect(wrapper.findAll('.is-next')).toHaveLength(1)
    wrapper.unmount()
  })

  it('says every item is found by meaning once done, and says nothing without a model', async () => {
    const done = await mountProgress('synthetic-embed', { model: 'synthetic-embed', total: 8, done: 8, running: false })
    expect(done.text()).toContain('8 条知识都能按意思找到了')
    expect(done.find('.is-next').exists()).toBe(false)
    done.unmount()
    const none = await mountProgress(null, { model: null, total: 0, done: 0, running: false })
    expect(none.find('[data-semantic-progress]').exists()).toBe(false)
    none.unmount()
  })

  it('starts a pass when a model is connected here', async () => {
    const wrapper = await mountProgress(null, { model: null, total: 0, done: 0, running: false })
    await wrapper.setProps({ model: 'synthetic-embed' })
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/semantic/fill', {})
    wrapper.unmount()
  })
})
