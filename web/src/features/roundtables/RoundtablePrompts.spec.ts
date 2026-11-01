import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t } from '@/i18n'
import RoundtablePrompts from './RoundtablePrompts.vue'

const writeText = vi.fn()
const prompt = (key: string) => document.body.querySelector<HTMLElement>(`[data-roundtable-prompt="${key}"]`)

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => { document.body.innerHTML = '' })

async function open(names: string[]) {
  const wrapper = mount(RoundtablePrompts, { props: { names }, attachTo: document.body })
  await wrapper.get('[data-roundtable-prompts]').trigger('click')
  await flushPromises()
  return wrapper
}

describe('RoundtablePrompts', () => {
  it('offers the entry syntax with the person\'s own FLAs, each copied with one click', async () => {
    const wrapper = await open(['Milo Reed', 'Nova Lane'])
    const texts = [...document.body.querySelectorAll('[data-roundtable-prompt] code')].map(code => code.textContent?.replace(' …', ''))
    expect(texts).toEqual(['@FLG 讨论', '@FLG Milo Reed、Nova Lane，一起讨论', '让 #FLA Milo Reed 去问 Nova Lane', '#FLA Milo Reed 在这里继续'])
    prompt('relay')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('让 #FLA Milo Reed 去问 Nova Lane ')
    expect(prompt('relay')!.classList).toContain('is-copied')
    wrapper.unmount()
  })

  it('offers only the group invitation before any FLA is known', async () => {
    const wrapper = await open([])
    expect([...document.body.querySelectorAll('[data-roundtable-prompt]')].map(item => item.getAttribute('data-roundtable-prompt'))).toEqual(['discuss'])
    wrapper.unmount()
  })

  it('says when the clipboard cannot be written', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const wrapper = await open(['Milo Reed'])
    prompt('discuss')!.click()
    await flushPromises()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(t('agentProfiles.mention.copyFailed'))
    expect(prompt('discuss')!.classList).not.toContain('is-copied')
    wrapper.unmount()
  })
})
