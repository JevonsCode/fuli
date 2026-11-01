import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import ProblemState from './ProblemState.vue'

// Synthetic problem text only.
async function mountProblem(props: Record<string, unknown>) {
  setActivePinia(createPinia())
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/somewhere')
  return mount(ProblemState, { props: { title: '本机服务还没准备好', ...props }, global: { plugins: [router] } })
}

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('the problem state', () => {
  it('names the problem, folds the raw error away, and reads again on request', async () => {
    const wrapper = await mountProblem({ detail: '一会儿就好。', error: 'synthetic failure' })
    expect(wrapper.get('[data-problem-state]').attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('本机服务还没准备好')
    expect(wrapper.get('.problem-error summary').text()).toBe('错误信息')
    await wrapper.get('[data-problem-retry]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('copies a ready prompt for the person\'s AI and says it did, without changing the button\'s size', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = await mountProblem({ error: 'synthetic failure' })
    const button = wrapper.get('[data-copy-fix-prompt]')
    expect(button.findAll('.copy-fix-labels > span')).toHaveLength(3)
    await button.trigger('click')
    await flushPromises()
    const prompt = writeText.mock.calls[0]![0] as string
    expect(prompt).toContain('现象：本机服务还没准备好')
    expect(prompt).toContain('页面：/somewhere')
    expect(prompt).toContain('错误信息：synthetic failure')
    expect(button.get('.is-shown').text()).toBe('已复制')
  })

  it('is the one place the problem is said: the shell error line is cleared, also after a retry fails again', async () => {
    const wrapper = await mountProblem({})
    const store = useConsoleStore()
    store.reportError(new Error('synthetic failure'))
    await flushPromises()
    expect(store.feedback).toBeNull()
    store.notify('synthetic success')
    await flushPromises()
    expect(store.feedback?.tone).toBe('success')
    wrapper.unmount()
  })

  it('waits while a retry runs', async () => {
    const wrapper = await mountProblem({ retrying: true, retryingLabel: '正在读取…' })
    expect(wrapper.get('[data-problem-retry]').attributes('disabled')).toBeDefined()
  })
})
