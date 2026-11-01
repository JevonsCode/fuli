import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { messages } from '@/i18n'
import GlossaryLayer from './GlossaryLayer.vue'
import layerSource from './GlossaryLayer.vue?raw'
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

  it('explains FULI\'s own words FLA, FLAs and FLG wherever they show', () => {
    const host = html('<span>FLA</span><span>FLAs</span><span>FLG</span>')
    const spans = host.querySelectorAll('span')
    expect([...spans].map(span => findTerm(span)?.term.id)).toEqual(['concept.fla', 'concept.flas', 'concept.flg'])
  })

  it('explains every destination and section only where it is tagged, never a common word elsewhere', () => {
    for (const [group, keys] of [['destination', messages['zh-CN'].shell.destinations], ['section', messages['zh-CN'].shell.sections]] as const) {
      for (const key of Object.keys(keys)) expect(GLOSSARY_TERMS.some(term => term.id === `${group}.${key}`), `${group}.${key}`).toBe(true)
    }
    const host = html('<a data-term="section.agentDirectory"><span>全部</span></a><button type="button">全部</button><b>我的</b>')
    expect(findTerm(host.querySelector('span'))?.term.id).toBe('section.agentDirectory')
    expect(findTerm(host.querySelector('button'))).toBeUndefined()
    expect(findTerm(host.querySelector('b'))).toBeUndefined()
  })

  it('keeps the term ids other pages tag with data-term', () => {
    const ids = new Set(GLOSSARY_TERMS.map(term => term.id))
    for (const id of ['occupation.catalog', 'occupation.archived', 'occupation.active', 'occupation.agentCount',
      'memory.current', 'memory.history', 'memory.all', 'memory.preferenceCount',
      'tonborg.escalate', 'tonborg.autonomous', 'tonborg.shared', 'tonborg.manual',
      'work.blocked', 'section.orchestrate', 'section.roundtables', 'section.askedYou']) expect(ids.has(id), id).toBe(true)
    // 阻塞 is explained wherever it shows, tagged or not.
    expect(findTerm(html('<span>阻塞</span>').querySelector('span'))?.term.id).toBe('work.blocked')
  })

  it('outlines a hovered term inside its own box, so a scrolling parent cannot clip it', () => {
    const rule = layerSource.slice(layerSource.indexOf('[data-glossary-hit] {'))
    const declarations = rule.slice(0, rule.indexOf('}'))
    expect(declarations).toMatch(/outline-offset:\s*-\d/)
    expect(declarations).not.toMatch(/border-radius/)
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

  it('leaves on a right-click instead of opening the context menu', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    const mode = useGlossaryMode()
    const host = html('<span>正文</span>')
    const outside = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    host.querySelector('span')!.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
    mode.toggle()
    await flushPromises()
    const inside = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    host.querySelector('span')!.dispatchEvent(inside)
    await flushPromises()
    expect(inside.defaultPrevented).toBe(true)
    expect(mode.active.value).toBe(false)
    expect(document.documentElement.hasAttribute('data-glossary')).toBe(false)
    wrapper.unmount()
  })

  it('unpins on Alt: the mode stays while Alt is held and ends when it comes up', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    const mode = useGlossaryMode()
    mode.toggle()
    alt('keydown')
    await flushPromises()
    expect(mode.pinned.value).toBe(false)
    expect(mode.active.value).toBe(true)
    alt('keyup')
    await flushPromises()
    expect(mode.active.value).toBe(false)
    wrapper.unmount()
  })

  it('leaves on Esc and closes the open explanation', async () => {
    const wrapper = mount(GlossaryLayer, { attachTo: document.body })
    const mode = useGlossaryMode()
    const host = html('<button type="button">待确认</button>')
    mode.toggle()
    await flushPromises()
    host.querySelector('button')!.click()
    await flushPromises()
    expect(document.querySelector('[data-glossary-term]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(mode.active.value).toBe(false)
    expect(document.querySelector('[data-glossary-term]')).toBeNull()
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
