import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import ActivityOriginBadge from './ActivityOriginBadge.vue'

describe('ActivityOriginBadge', () => {
  beforeEach(() => setLocale('zh-CN', { persist: false }))

  it('labels AI-internal work with its purpose and explains the source on hover', () => {
    const wrapper = mount(ActivityOriginBadge, { props: { origin: { version: 1, kind: 'ai_internal', source: 'sealed_worker', purpose: 'test' } } })
    expect(wrapper.get('[data-activity-origin]').text()).toBe('AI 内部 · 测试')
    expect(wrapper.get('[data-activity-origin]').attributes('title')).toContain('不是你发起的任务')
  })

  it('shows nothing for ordinary or legacy work', () => {
    expect(mount(ActivityOriginBadge, { props: { origin: null } }).find('[data-activity-origin]').exists()).toBe(false)
    expect(mount(ActivityOriginBadge).find('[data-activity-origin]').exists()).toBe(false)
  })
})
