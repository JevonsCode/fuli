import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import motionCss from '../styles/motion.css?raw'
import { installPageTransitions, motionConfigReduced, PAGE_CHANGING, PAGE_ENTER, suppressNextPageTransition } from './motion'
import { setMotionPreference } from './motion-preference'

const page = (name: string) => defineComponent({ name, render: () => h('section', { class: 'view', 'data-page': name }) })
let app: App | null = null

/** A shell like AppShell's: the routed page is a direct child of .app-main. */
async function mounted() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: page('home') },
      { path: '/a', component: page('a') },
      { path: '/b', component: page('b') },
      { path: '/workbench/:list', name: 'workbench-list', component: page('list') },
    ],
  })
  installPageTransitions(router)
  const host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h('main', { class: 'app-main' }, [h(RouterView)]) })
  app.use(router)
  await router.push('/')
  app.mount(host)
  await nextTick()
  return router
}
const roots = () => [...document.querySelectorAll<HTMLElement>('.app-main > *')]
async function settled() {
  await nextTick()
  await nextTick()
}

describe('page transitions', () => {
  let start: ReturnType<typeof vi.fn>
  beforeEach(() => {
    setMotionPreference('system')
    start = vi.fn((update: () => Promise<void>) => ({ finished: update() }))
    Object.assign(document, { startViewTransition: start })
  })
  afterEach(() => {
    app?.unmount()
    app = null
    document.body.innerHTML = ''
  })

  // Jevons 11-08 (会先只显示左边一半然后再显示全部): every View Transition rebuilt the page's layers
  // when it ended, and the browser painted them a tile at a time, the right half late.
  it('changes an ordinary page without a View Transition: the old page is gone and the new one rises in on its own root', async () => {
    const router = await mounted()
    await router.push('/a')
    await settled()
    expect(start).not.toHaveBeenCalled()
    expect(roots().map(root => root.dataset.page)).toEqual(['a'])
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(true)
  })

  it('drops the rise-in class once its animation ends, so a later re-render never replays it', async () => {
    const router = await mounted()
    await router.push('/a')
    await settled()
    const root = roots()[0]
    root.querySelector('*')?.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(root.classList.contains(PAGE_ENTER)).toBe(true)
    root.dispatchEvent(new Event('animationend'))
    expect(root.classList.contains(PAGE_ENTER)).toBe(false)
  })

  it('keeps one View Transition for a workbench card growing into its list page, and names the bars only while it runs', async () => {
    let during = false
    start.mockImplementation((update: () => Promise<void>) => {
      during = document.documentElement.classList.contains(PAGE_CHANGING)
      return { finished: update() }
    })
    const router = await mounted()
    await router.push('/workbench/running')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(start).toHaveBeenCalledOnce()
    expect(during).toBe(true)
    expect(document.documentElement.classList.contains(PAGE_CHANGING)).toBe(false)
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(false)
    await router.push('/')
    expect(start).toHaveBeenCalledTimes(2)
    await router.push('/workbench/done')
    await router.push('/a')
    await settled()
    expect(start).toHaveBeenCalledTimes(3)
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(true)
  })

  it('leaves an in-page query change and reduced motion alone', async () => {
    const router = await mounted()
    await router.push('/a')
    await settled()
    roots()[0].classList.remove(PAGE_ENTER)
    await router.push({ path: '/a', query: { tab: 'history' } })
    await settled()
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(false)
    setMotionPreference('reduced')
    await router.push('/b')
    await settled()
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(false)
    expect(motionConfigReduced.value).toBe('always')
    expect(start).not.toHaveBeenCalled()
  })

  it('still rises in where the browser has no View Transitions', async () => {
    Object.assign(document, { startViewTransition: undefined })
    const router = await mounted()
    await router.push('/workbench/done')
    await settled()
    expect(router.currentRoute.value.path).toBe('/workbench/done')
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(true)
  })

  it('skips the rise-in for one in-page view switch, then animates again', async () => {
    const router = await mounted()
    suppressNextPageTransition()
    await router.push('/a')
    await settled()
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(false)
    await router.push('/b')
    await settled()
    expect(roots()[0].classList.contains(PAGE_ENTER)).toBe(true)
  })
})

describe('the rise-in', () => {
  it('moves only opacity and transform, so the page keeps its final width from its first frame', () => {
    expect(motionCss).toMatch(/\.page-enter \{ animation: page-in var\(--motion-enter\) both; \}/)
    const keyframes = motionCss.match(/@keyframes page-in \{(.*)\}/)?.[1] ?? ''
    const properties = [...keyframes.matchAll(/([a-z-]+):/g)].map(match => match[1])
    expect(properties.length).toBeGreaterThan(0)
    expect(properties.every(property => property === 'opacity' || property === 'transform')).toBe(true)
  })
})
