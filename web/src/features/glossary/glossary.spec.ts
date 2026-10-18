import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { messages } from '@/i18n'
import GlossaryLayer from './GlossaryLayer.vue'
import { useGlossaryMode } from './glossary-mode'
import { findTerm, GLOSSARY_TERMS } from './terms'

function html(markup: string) {
  const host = document.createElement('div')
  host.innerHTML = markup
  document.body.append(host)
  return host
}

function resolve(locale: keyof typeof messages, key: string) {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages[locale])
}

afterEach(() => { document.body.innerHTML = '' })

describe('glossary terms', () => {
  it('has a label and an explanation for every term in both languages', () => {
    for (const term of GLOSSARY_TERMS) {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        expect(typeof resolve(locale, term.labelKey), `${locale} ${term.labelKey}`).toBe('string')
        expect(typeof resolve(locale, term.bodyKey), `${locale} ${term.bodyKey}`).toBe('string')
      }
    }
  })

  it('finds a term from data-term first, then from short visible text in either language', () => {
    const host = html('<span data-term="weight.person"><b>100%</b></span><em>已知的已知</em><i>Known known</i><p>已知的已知 is discussed at length in this paragraph</p>')
    expect(findTerm(host.querySelector('b'))?.term.id).toBe('weight.person')
    expect(findTerm(host.querySelector('em'))?.term.id).toBe('quadrant.known_known')
    expect(findTerm(host.querySelector('i'))?.term.id).toBe('quadrant.known_known')
    expect(findTerm(host.querySelector('p'))).toBeUndefined()
  })
})

describe('GlossaryLayer', () => {
  function alt(type: 'keydown' | 'keyup') { window.dispatchEvent(new KeyboardEvent(type, { key: 'Alt' })) }

  it('turns on while Alt is held, explains the clicked term, and swallows that click', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    const host = html('<button type="button">待确认</button>')
    let activated = 0
    host.querySelector('button')!.addEventListener('click', () => { activated++ })

    alt('keydown')
    await flushPromises()
    expect(document.documentElement.hasAttribute('data-glossary')).toBe(true)
    host.querySelector('button')!.click()
    await flushPromises()
    expect(activated).toBe(0)
    expect(document.querySelector('[data-glossary-term]')?.getAttribute('data-glossary-term')).toBe('review.pending')

    alt('keyup')
    await flushPromises()
    expect(document.documentElement.hasAttribute('data-glossary')).toBe(false)
    host.querySelector('button')!.click()
    expect(activated).toBe(1)
    wrapper.unmount()
  })

  it('stays on while pinned and still lets the toggle itself turn it off', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    const mode = useGlossaryMode()
    const host = html('<button type="button" data-glossary-toggle>i</button>')
    host.querySelector('button')!.addEventListener('click', mode.toggle)
    mode.toggle()
    await flushPromises()
    expect(document.documentElement.hasAttribute('data-glossary')).toBe(true)
    host.querySelector('button')!.click()
    await flushPromises()
    expect(mode.active.value).toBe(false)
    expect(document.documentElement.hasAttribute('data-glossary')).toBe(false)
    wrapper.unmount()
  })

  it('drops Alt when the window loses focus', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    alt('keydown')
    window.dispatchEvent(new Event('blur'))
    await flushPromises()
    expect(useGlossaryMode().active.value).toBe(false)
    wrapper.unmount()
  })
})
