import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@/i18n'
import AgentMentionCopy from './AgentMentionCopy.vue'

const writeText = vi.fn()
const card = () => document.body.querySelector('[data-agent-mention-card]')
const render = (props: Record<string, unknown> = {}) =>
  mount(AgentMentionCopy, { props: { name: 'Jamie Ash', ...props }, attachTo: document.body })

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

async function hover(wrapper: ReturnType<typeof render>) {
  await wrapper.get('[data-agent-mention-copy]').trigger('pointerenter', { pointerType: 'mouse' })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushPromises()
}

describe('AgentMentionCopy', () => {
  it('copies #FLA and the name in one click, then says so', async () => {
    vi.useFakeTimers()
    const wrapper = render()
    const button = wrapper.get('[data-agent-mention-copy]')
    expect(button.text()).toBe('复制 #FLA')
    expect(button.attributes('aria-label')).toBe('复制 #FLA Jamie Ash')
    await button.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA Jamie Ash ')
    expect(button.text()).toBe('已复制')
    expect(wrapper.get('[role="status"]').text()).toBe('已复制')
    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(button.text()).toBe('复制 #FLA')
    wrapper.unmount()
  })

  it('says when the clipboard cannot be written', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const wrapper = render()
    await wrapper.get('[data-agent-mention-copy]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('无法写入剪贴板')
    wrapper.unmount()
  })

  it('shows ready-to-use phrasings on hover, each copied in one click', async () => {
    const wrapper = render({ partner: 'Nova Lane' })
    expect(card()).toBeNull()
    await hover(wrapper)
    expect(card()?.textContent).toContain('在任何聊天里叫 Jamie Ash 来干活')
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>('[data-mention-phrasing]')]
    expect(rows.map((row) => row.dataset.mentionPhrasing)).toEqual(['continue', 'pair', 'recommend'])
    expect(rows.map((row) => row.querySelector('.agent-mention-text')?.textContent)).toEqual([
      '#FLA Jamie Ash 在这里继续',
      '@FLG Jamie Ash、Nova Lane，一起讨论 …',
      '@FLG 让 Jamie Ash 参加，再推荐一位 …',
    ])
    rows[1]!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('@FLG Jamie Ash、Nova Lane，一起讨论 ')
    expect(rows[1]!.textContent).toContain('已复制')
    expect(card()?.textContent).toContain('@FLG 要写在开头')
    wrapper.unmount()
  })

  it('leaves out the pair phrasing without another FLA and speaks English in en-US', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = render()
    expect(wrapper.get('[data-agent-mention-copy]').text()).toBe('Copy #FLA')
    await hover(wrapper)
    const rows = [...document.body.querySelectorAll('[data-mention-phrasing] .agent-mention-text')].map((row) => row.textContent)
    expect(rows).toEqual(['#FLA Jamie Ash continue here', '@FLG with Jamie Ash, recommend one more for …'])
    wrapper.unmount()
  })
})
