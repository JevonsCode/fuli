import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { agentProfileMessages } from '@/i18n/messages/agent-profiles'
import { setMotionPreference } from '@/lib/motion-preference'
import { router } from '@/router'
import operatingSkill from '../../../../skills/operating-fuli/SKILL.md?raw'
import collaborationDoc from '../../../../docs/agent-conversations-and-collaboration.md?raw'
import mentionParser from '../../../../src/graphiti/fla-mention.js?raw'
import HowtoPage from '@/pages/HowtoPage.vue'
import { howtoContent } from './howto-content'

const LOCALES = ['zh-CN', 'en-US'] as const

// Every FULI keyword a phrase or note uses, and where FULI documents it.
const DOCUMENTED: Record<string, [source: string, snippet: string]> = {
  '#FLA': [operatingSkill, '`#FLA Name` (at the start of the prompt or of a line'],
  '@FLG': [operatingSkill, '`@FLG <question>` (only at the start of the prompt)'],
  '@FLA 结束': [operatingSkill, '`@FLA 结束`'],
  '@FLA end': [mentionParser, '`@FLA 结束` (end, release)'],
}
const KEYWORD = /[#@]FL[AG](?: (?:结束|end))?(?![\p{L}\p{N}])/gu

afterEach(() => {
  setLocale('zh-CN', { persist: false })
  setMotionPreference('system')
  vi.unstubAllGlobals()
})

describe('howto content', () => {
  it('uses only FULI syntax that skills/ and src/ document, at the start of a phrase', () => {
    for (const [snippet, [source, text]] of Object.entries(DOCUMENTED)) expect(source, snippet).toContain(text)
    for (const locale of LOCALES) {
      for (const move of howtoContent(locale).moves) {
        for (const text of [...move.phrases, move.note]) {
          for (const [keyword] of text.matchAll(KEYWORD)) expect(DOCUMENTED, `${locale} ${move.id}: ${keyword}`).toHaveProperty([keyword])
        }
        for (const phrase of move.phrases) {
          // A keyword counts only at the start; anything after it is the person's own words.
          const keywords = [...phrase.matchAll(KEYWORD)]
          expect(keywords.length, phrase).toBeLessThanOrEqual(1)
          if (keywords.length) expect(keywords[0].index, phrase).toBe(0)
          expect(phrase, 'no other @ or # address').not.toMatch(/(?<!^)[#@]\S/u)
        }
      }
    }
  })

  it('calls an FLA the way the console\'s copy button does, and Bole as documented', () => {
    for (const locale of LOCALES) {
      const moves = Object.fromEntries(howtoContent(locale).moves.map(move => [move.id, move]))
      expect(moves.continue!.phrases[0]).toMatch(new RegExp(`^#FLA ‹[^›]+› ${agentProfileMessages[locale].mention.continue}$`, 'u'))
      expect(moves.recruit!.phrases[0]).toMatch(/^#FLA Bole /u)
    }
    expect(collaborationDoc).toContain('`#FLA Bole 招一个前端`')
  })

  it('keeps both languages in step: the same moves, phrases, cases and steps in the same order', () => {
    const [zh, en] = LOCALES.map(howtoContent)
    expect(en!.moves.map(move => [move.id, move.phrases.length, move.term])).toEqual(zh!.moves.map(move => [move.id, move.phrases.length, move.term]))
    expect(en!.cases.map(story => [story.id, story.steps.map(step => [Boolean(step.client), Boolean(step.fuli)])]))
      .toEqual(zh!.cases.map(story => [story.id, story.steps.map(step => [Boolean(step.client), Boolean(step.fuli)])]))
  })
})

describe('HowtoPage', () => {
  it('is the settings section after 关于, with its own route', () => {
    expect(router.resolve('/howto').name).toBe('howto')
    expect(router.resolve('/howto').meta.title).toBe('routes.howto.title')
  })

  it('shows every move with its words and a copy button that copies them exactly', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const wrapper = mount(HowtoPage)
    const moves = howtoContent('zh-CN').moves
    // PageColumns deals the cards into two columns, so the DOM order is not the list order.
    expect(wrapper.findAll('[data-howto-move]').map(card => card.attributes('data-howto-move')).sort()).toEqual(moves.map(move => move.id).sort())
    for (const move of moves) {
      const card = wrapper.get(`[data-howto-move="${move.id}"]`)
      expect(card.get('h3').text()).toBe(move.title)
      expect(card.findAll('[data-howto-phrase]').map(code => code.text())).toEqual(move.phrases)
      expect(card.findAll('[data-howto-copy]')).toHaveLength(move.phrases.length)
      expect(card.find('svg.howto-scene').exists()).toBe(true)
    }
    // One headline per section; card titles sit below them.
    expect(wrapper.findAll('h2').map(h => h.text())).toEqual(['这样跟 AI 说', '案例'])

    const button = wrapper.get('[data-howto-move="continue"] [data-howto-copy]')
    await button.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA ‹姓名› 在这里继续')
    expect(button.classes()).toContain('is-copied')
    // Both labels stay in the button, so its width does not change.
    expect(button.findAll('.howto-copy-label > span').map(span => span.text())).toEqual(['复制', '已复制'])
    wrapper.unmount()
  })

  it('tells the person when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const wrapper = mount(HowtoPage)
    await wrapper.get('[data-howto-copy]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-howto-move="anyClient"] [role="status"]').text()).toBe('无法写入剪贴板，请手动选中复制')
    wrapper.unmount()
  })

  it('tells the real cases as timelines, in both languages', () => {
    const wrapper = mount(HowtoPage)
    const cases = howtoContent('zh-CN').cases
    expect(wrapper.findAll('[data-howto-case]').map(card => card.attributes('data-howto-case')).sort()).toEqual(['dingdong', 'fuli'])
    for (const story of cases) {
      const card = wrapper.get(`[data-howto-case="${story.id}"]`)
      expect(card.get('h3').text()).toBe(story.title)
      expect(card.findAll('[data-howto-step]')).toHaveLength(story.steps.length)
    }
    expect(wrapper.get('[data-howto-case="fuli"]').text()).toContain('Lyra North')
    wrapper.unmount()

    setLocale('en-US', { persist: false })
    const english = mount(HowtoPage)
    expect(english.findAll('h2').map(h => h.text())).toEqual(['Say it to your AI', 'Real cases'])
    expect(english.get('[data-howto-case="fuli"] h3').text()).toBe('Building FULI with FULI')
    expect(english.get('[data-howto-move="continue"] [data-howto-phrase]').text()).toBe('#FLA ‹name› continue here')
    english.unmount()
  })

  it('loops the scenes only while motion is allowed; reduced motion shows the finished picture', async () => {
    const wrapper = mount(HowtoPage)
    expect(wrapper.findAll('svg.howto-scene.is-animated')).toHaveLength(8)
    setMotionPreference('reduced')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('svg.howto-scene.is-animated')).toHaveLength(0)
    expect(wrapper.findAll('.howto-timeline.is-animated')).toHaveLength(0)
    // Nothing is hidden at rest: the typed token and every scene part are drawn.
    expect(wrapper.get('[data-howto-move="discuss"] .howto-bubble text').text()).toBe('@FLG')
    expect(wrapper.findAll('[data-howto-move="delegate"] .howto-actor')).toHaveLength(4)
    wrapper.unmount()
  })
})
