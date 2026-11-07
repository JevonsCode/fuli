import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import AgentAvatar from './AgentAvatar.vue'
import { defaultAvatarUrl } from './agent-avatar'

afterEach(() => { vi.useRealTimers() })

// A face rendered inside whatever the place wraps it in.
async function place(wrap: (face: ReturnType<typeof h>) => ReturnType<typeof h>, props: { agentId: string; name?: string; link?: boolean }) {
  const wrapper = mount(defineComponent({ render: () => wrap(h(AgentAvatar, props)) }), { attachTo: document.body })
  await nextTick()
  return wrapper
}

describe('AgentAvatar', () => {
  it('is the FLA own link where nothing else handles the face: named, focusable, Enter clicks it', async () => {
    const wrapper = await place(face => h('div', [face]), { agentId: 'agent-1', name: 'Ada Vale' })
    const img = wrapper.get('img')
    expect(img.attributes()).toMatchObject({ 'data-agent-portrait': 'agent-1', 'data-agent-link': 'true', role: 'link', tabindex: '0', alt: 'Ada Vale', draggable: 'false' })
    expect(img.attributes('aria-label')).toContain('Ada Vale')
    const clicks = vi.fn()
    img.element.addEventListener('click', clicks)
    await img.trigger('keydown', { key: 'Enter' })
    expect(clicks).toHaveBeenCalledOnce()
    const menus = vi.fn()
    img.element.addEventListener('contextmenu', menus)
    await img.trigger('keydown', { key: 'F10', shiftKey: true })
    await img.trigger('keydown', { key: 'ContextMenu' })
    expect(menus).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('stays part of the link or button around it', async () => {
    const wrapper = await place(face => h('a', { href: '/elsewhere' }, [face]), { agentId: 'agent-1', name: 'Ada Vale' })
    const img = wrapper.get('img')
    expect(img.attributes('data-agent-portrait')).toBe('agent-1')
    for (const name of ['data-agent-link', 'role', 'tabindex']) expect(img.attributes(name)).toBeUndefined()
    expect(img.attributes('alt')).toBe('')
    wrapper.unmount()
  })

  it('leaves the click to a place that handles it, and takes no focus where it is hidden', async () => {
    const card = await place(face => h('div', [face]), { agentId: 'agent-1', name: 'Ada Vale', link: false })
    expect(card.get('img').attributes('data-agent-link')).toBeUndefined()
    expect(card.get('img').attributes('tabindex')).toBeUndefined()
    const hidden = await place(face => h('span', { 'aria-hidden': 'true' }, [face]), { agentId: 'agent-1', name: 'Ada Vale' })
    expect(hidden.get('img').attributes('data-agent-link')).toBe('true')
    expect(hidden.get('img').attributes('tabindex')).toBeUndefined()
    expect(hidden.get('img').attributes('alt')).toBe('')
    for (const wrapper of [card, hidden]) wrapper.unmount()
  })

  it('takes a built-in role by its template ID and names it by its current name', async () => {
    const wrapper = await place(face => h('h2', [face]), { agentId: 'tonborg' })
    const img = wrapper.get('img')
    expect(img.attributes('data-agent-portrait')).toBe('employee.tonborg')
    expect(img.attributes('alt')).toBe('Tonborg')
    wrapper.unmount()
  })

  it('falls back to its default look when the picture cannot load', async () => {
    const wrapper = await place(face => h('div', [face]), { agentId: 'agent-1', name: 'Ada Vale' })
    await wrapper.get('img').trigger('error')
    expect(wrapper.get('img').attributes('src')).toBe(defaultAvatarUrl('agent-1'))
    wrapper.unmount()
  })

  it('opens the portrait menu on a touch long-press and swallows the click that ends it', async () => {
    vi.useFakeTimers()
    const wrapper = await place(face => h('div', [face]), { agentId: 'agent-1', name: 'Ada Vale' })
    const img = wrapper.get('img')
    const menus: MouseEvent[] = []
    img.element.addEventListener('contextmenu', event => menus.push(event))
    img.element.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 30 }), { pointerType: 'touch' }))
    vi.advanceTimersByTime(500)
    expect(menus).toHaveLength(1)
    expect([menus[0]!.clientX, menus[0]!.clientY]).toEqual([12, 30])
    const reachedPage = vi.fn()
    document.body.addEventListener('click', reachedPage)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    img.element.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(reachedPage).not.toHaveBeenCalled()
    document.body.removeEventListener('click', reachedPage)
    wrapper.unmount()
  })
})
