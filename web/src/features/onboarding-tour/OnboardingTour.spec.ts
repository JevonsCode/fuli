import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import { whatsNew } from '@/features/whats-new/whats-new'
import WhatsNewNotice from '@/features/whats-new/WhatsNewNotice.vue'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConsoleState } from '@/types'
import OnboardingTour from './OnboardingTour.vue'
import TourResumeNotice from './TourResumeNotice.vue'
import { TOUR_STEPS, startTour, stepTarget, tour, tourDue } from './onboarding-tour'

// The beginner's guide in the console frame. Synthetic state and answers only; nothing on this computer is read.
const state = (firstRunGuide: ConsoleState['firstRunGuide'], ask = false): ConsoleState => ({
  mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], activePersonalSpaceId: 'space',
  projects: [], subscriptions: [], personalProjects: [], captureOnboarding: { ask }, firstRunGuide,
} as ConsoleState)
const WHATS_NEW = { version: '0.30.0', lines: { zh: ['按钮不再乱跑。'], en: ['Buttons stop wandering.'] },
  releaseUrl: 'https://github.com/JevonsCode/fuli/releases/tag/v0.30.0', notice: { skipped: 0, releasesUrl: 'https://github.com/JevonsCode/fuli/releases' } }

const mounted: Array<{ unmount: () => void }> = []
function mountShell(initial: ConsoleState | null) {
  const posts: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'PUT') posts.push({ url, body: JSON.parse(String(init.body)) })
    if (url === '/api/first-run-guide/tour') return Response.json({ open: false, tourSeen: 1 })
    if (url === '/api/first-run-guide') return Response.json({ open: false, tourSeen: null })
    if (url === '/api/system/whats-new') return Response.json(WHATS_NEW)
    if (url === '/api/system/whats-new/seen') return Response.json({ ...WHATS_NEW, notice: null })
    return Response.json({}, { status: 404 })
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = initial
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  const Frame = defineComponent({ render: () => [h(OnboardingTour), h('div', [h(TourResumeNotice), h(WhatsNewNotice)])] })
  const wrapper = mount(Frame, { global: { plugins: [pinia, router] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, store, router, posts }
}

const find = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const dialog = () => find('[data-onboarding-tour]')
const current = () => find('.tour-step.is-current')
async function click(selector: string) {
  find(selector)!.click()
  await flushPromises()
}

beforeEach(() => {
  Object.assign(tour, { open: false, paused: false, step: 0, offered: false, deciding: false })
  Object.assign(whatsNew, { shown: null, closed: false })
})
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('beginner\'s guide', () => {
  it('opens once for an installation from before, ahead of what is new, and closing with 跳过 counts as seen', async () => {
    const { posts } = mountShell(state(undefined))
    await flushPromises()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('新手引导')
    expect(current()?.dataset.tourStep).toBe('what')
    expect(find('[data-whats-new]')).toBeNull()
    // The notice waiting behind the guide was not on screen, so it is not marked seen:
    // a console closed now still shows it next time.
    const seen = () => posts.filter(post => post.url === '/api/system/whats-new/seen')
    expect(seen()).toEqual([])

    await click('[data-tour-skip]')
    await flushPromises()
    expect(seen()).toEqual([{ url: '/api/system/whats-new/seen', body: { version: WHATS_NEW.version } }])
    expect(dialog()).toBeNull()
    expect(posts.filter(post => post.url === '/api/first-run-guide/tour')).toEqual([{ url: '/api/first-run-guide/tour', body: { version: 1 } }])
    expect(find('[data-whats-new]')).not.toBeNull()
  })

  it('waits while the first-run dialog is open and opens once it closes', async () => {
    const { store } = mountShell(state({ open: true, tourSeen: null }, true))
    await flushPromises()
    expect(tour.open).toBe(false)
    store.captureQuestionDismissed = true
    await store.closeFirstRunGuide('skipped')
    await flushPromises()
    expect(dialog()).not.toBeNull()
  })

  it('stays closed once this version was shown; 再看一遍 starts it again at step 1', async () => {
    mountShell(state({ open: false, tourSeen: 1 }))
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(find('[data-whats-new]')).not.toBeNull()
    startTour()
    await flushPromises()
    expect(current()?.dataset.tourStep).toBe('what')
  })

  it('steps forward and back with the buttons in place, says each step, and Esc closes it as seen', async () => {
    const { posts } = mountShell(state({ open: false, tourSeen: null }))
    await flushPromises()
    const footer = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('.ui-dialog__footer button')]
    const buttons = footer()
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['跳过', '上一步', '下一步'])
    expect(find('[data-tour-back]')).toHaveProperty('disabled', true)
    expect(find('[data-tour-progress]')?.textContent).toBe('第 1 步，共 6 步：FULI 帮你的 AI 记事')

    await click('[data-tour-next]')
    expect(current()?.dataset.tourStep).toBe('clients')
    expect(find('[data-tour-progress]')?.textContent).toBe('第 2 步，共 6 步：先接入你的客户端')
    // Only the current step can be read or reached; the others only keep their height.
    const hidden = [...dialog()!.querySelectorAll<HTMLElement>('.tour-step:not(.is-current)')]
    expect(hidden).toHaveLength(TOUR_STEPS.length - 1)
    expect(hidden.every(step => step.getAttribute('aria-hidden') === 'true' && step.hasAttribute('inert'))).toBe(true)
    expect([...dialog()!.querySelectorAll<HTMLButtonElement>('[data-tour-go]')].filter(button => !button.disabled)
      .map(button => button.dataset.tourGo)).toEqual(['clients'])

    for (let step = 2; step < TOUR_STEPS.length; step += 1) await click('[data-tour-next]')
    expect(current()?.dataset.tourStep).toBe('roundtable')
    expect(footer()).toEqual(buttons)
    expect(find('[data-tour-next]')?.textContent?.trim()).toBe('完成')
    await click('[data-tour-back]')
    expect(current()?.dataset.tourStep).toBe('projects')

    dialog()!.dispatchEvent(new Event('cancel', { cancelable: true }))
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(posts.some(post => post.url === '/api/first-run-guide/tour')).toBe(true)
  })

  it('goes to a step\'s place and continues from that step from the corner', async () => {
    const { router } = mountShell(state({ open: false, tourSeen: null }))
    await flushPromises()
    await click('[data-tour-next]')
    await click('[data-tour-go="clients"]')
    expect(router.currentRoute.value.fullPath).toBe('/settings?tab=clients')
    expect(dialog()).toBeNull()
    expect(find('[data-tour-resume]')?.textContent).toContain('新手引导停在第 2 步')

    await click('[data-tour-resume-continue]')
    expect(current()?.dataset.tourStep).toBe('clients')
    expect(find('[data-tour-resume]')).toBeNull()
    await click('[data-tour-go="clients"]')
    await click('[data-tour-resume-close]')
    expect([tour.open, tour.paused]).toEqual([false, false])
  })

  it('speaks English when the console does', async () => {
    setLocale('en-US', { persist: false })
    mountShell(state({ open: false, tourSeen: null }))
    await flushPromises()
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Beginner\'s guide')
    expect(find('[data-tour-progress]')?.textContent).toBe('Step 1 of 6: FULI remembers for your AI')
  })
})

describe('beginner\'s guide model', () => {
  it('is due until the server holds this version, and sends each place-step to its page', () => {
    expect([tourDue(state(undefined)), tourDue(state({ open: false, tourSeen: null })), tourDue(state({ open: false, tourSeen: 1 }))])
      .toEqual([true, true, false])
    expect(TOUR_STEPS.map(step => stepTarget(step.id, 'space'))).toEqual([
      null, '/settings?tab=clients', '/project-agents', '/knowledge/personal/space/directory', '/personal/space/projects/graph', '/roundtables'])
  })
})
