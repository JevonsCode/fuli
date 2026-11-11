import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import GlossaryLayer from '@/features/glossary/GlossaryLayer.vue'
import { useGlossaryMode } from '@/features/glossary/glossary-mode'
import { GLOSSARY_TERMS } from '@/features/glossary/terms'
import { modelGuideUrl } from '@/features/model-settings/model'
import { messages, setLocale } from '@/i18n'

import AiHelpButton from './AiHelpButton.vue'
import { AI_TASK_IDS, aiTaskPrompt } from './ai-task-prompts'

const UI_COPY_LIMIT = 100

beforeEach(() => setLocale('zh-CN', { persist: false }))
let wrapper: VueWrapper | null = null
afterEach(async () => {
  useGlossaryMode().explaining.value = null
  await flushPromises()
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

function mountHelp(term: string) {
  wrapper = mount({ components: { AiHelpButton, GlossaryLayer }, template: `<div><AiHelpButton term="${term}" /><GlossaryLayer /></div>` },
    { attachTo: document.body })
  return wrapper
}

describe('a card\'s entry to its explanation', () => {
  it('opens the glossary card with what the area is for and a copyable prompt filled with this console\'s address', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const help = mountHelp('task.models')
    // An area an AI can do: the blue AI mark, named by what it does and where; never a question mark.
    const entry = help.get('[data-ai-help]')
    expect(entry.attributes('data-ai-entry')).toBeDefined()
    expect(entry.attributes('aria-label')).toBe('让 AI 来做：模型与用量')
    expect(entry.attributes('title')).toBe('让 AI 来做：模型与用量')
    expect(entry.html()).toContain('M10 5.5c')
    await help.get('[data-ai-help]').trigger('click')
    await flushPromises()
    const card = document.querySelector('[data-glossary-term="task.models"]')!
    expect(card.textContent).toContain('告诉你的 Agent 用哪个接口和 Key，它来接好')
    expect(card.querySelector('pre')!.textContent).toContain(`GET ${window.location.origin}/api/model-backends/roles`)
    ;(card.querySelector('[data-ai-task-copy]') as HTMLButtonElement).click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(aiTaskPrompt('models', 'zh-CN', {
      console: window.location.origin, area: '模型与用量', guide: modelGuideUrl('zh-CN') }))
    expect(card.querySelector('[data-ai-task-copy]')!.textContent).toBe('已复制')
  })

  it('a change only the person makes explains why and offers no prompt', async () => {
    const help = mountHelp('task.aiPermissions')
    // Nothing for an AI here: the entry is the 「?」 that only explains.
    expect(help.get('[data-ai-help]').attributes('data-ai-entry')).toBeUndefined()
    expect(help.get('[data-ai-help]').attributes('aria-label')).toBe('「AI 权限」是做什么的')
    await help.get('[data-ai-help]').trigger('click')
    await flushPromises()
    const card = document.querySelector('[data-glossary-term="task.aiPermissions"]')!
    expect(card.textContent).toContain('只能你本人在这里开关')
    expect(card.querySelector('[data-ai-task]')).toBeNull()
  })

  it('every topic has its explanation in both languages within the copy limit, and every prompt id is used', () => {
    const topics = GLOSSARY_TERMS.filter(term => term.group === 'task')
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const bodies = messages[locale].aiHelp.topics as Record<string, string>
      for (const term of topics) {
        const body = bodies[term.id.replace('task.', '')]
        expect(body, `${locale} ${term.id}`).toBeTruthy()
        expect(body.length, `${locale} ${term.id}`).toBeLessThanOrEqual(UI_COPY_LIMIT + 40)
      }
      expect(Object.keys(bodies).sort()).toEqual(topics.map(term => term.id.replace('task.', '')).sort())
    }
    const used = new Set(topics.flatMap(term => term.aiTask ?? []))
    expect([...AI_TASK_IDS].filter(task => !used.has(task))).toEqual([])
  })
})
