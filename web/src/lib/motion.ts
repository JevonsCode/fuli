import { computed, nextTick } from 'vue'
import type { Router } from 'vue-router'
import { motionPreference, motionReduced } from './motion-preference'

/**
 * Lively motion (2026-11-01). One spring for everything that appears or
 * moves in script, matching the CSS --motion-ease-spring in base.css.
 */
export const SPRING = { type: 'spring', stiffness: 420, damping: 32, mass: 0.8 } as const

/** motion-v's MotionConfig: the in-app switch forces reduced motion; otherwise the system decides. */
export const motionConfigReduced = computed(() => (motionPreference.value === 'reduced' ? 'always' : 'user'))

/** On the root element while a workbench card grows into its list page (styles/motion.css). */
export const PAGE_CHANGING = 'is-page-changing'

/** On each root element of a page that just arrived, until its rise-in ends (styles/motion.css). */
export const PAGE_ENTER = 'page-enter'

/**
 * The workbench list pages: a card on 工作台 (/) grows into its own page and shrinks
 * back, so a change between the two runs as a shared View Transition
 * (styles/motion.css, data-list-morph). Leaving a list page for any other page does not.
 */
const MORPH_ROUTE = 'workbench-list'

let skipNextTransition = false

/**
 * Mark the next navigation as an in-page view switch (a tab, a mode) so the
 * page does not rise in again. The flag is one-shot: the next path change is
 * skipped, then every later navigation animates again.
 */
export function suppressNextPageTransition() {
  skipNextTransition = true
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } }

/**
 * Page changes: the old page leaves at once and the new one rises in on its own
 * root elements from its first frame, with opacity and transform only, so it is
 * at its final width and place the whole time. No View Transition wraps an
 * ordinary page change: when one ends the browser rebuilds the page's layers and
 * painted them a tile at a time for a few frames, the right half blank or blurred
 * (Jevons 11-08: 会先只显示左边一半然后再显示全部). Only the workbench card that grows
 * into its list page keeps one. A query or hash change on the same path (an
 * in-page tab) does not animate, nor does a page that stays mounted, nor anything
 * while motion is reduced.
 */
export function installPageTransitions(router: Router) {
  let finish: (() => void) | null = null
  let before: Set<Element> | null = null
  const settle = () => {
    const done = finish
    finish = null
    if (done) void nextTick(done)
  }
  const riseIn = () => {
    const shown = before
    before = null
    if (shown) void nextTick(() => pageRoots().forEach(root => shown.has(root) || enter(root)))
  }
  router.beforeResolve((to, from) => {
    before = null
    if (motionReduced() || !from.matched.length || to.path === from.path) return
    if (skipNextTransition) {
      skipNextTransition = false
      return
    }
    const doc = document as ViewTransitionDocument
    const morph = (to.name === MORPH_ROUTE && from.path === '/') || (from.name === MORPH_ROUTE && to.path === '/')
    if (!doc.startViewTransition || !morph) {
      before = new Set(pageRoots())
      return
    }
    // The top bar and dock take their transition names only while a page changes:
    // a named element is a backdrop root, and the dock's glass would stop blurring the page.
    const root = document.documentElement
    root.classList.add(PAGE_CHANGING)
    return new Promise<void>((resolve) => {
      const transition = doc.startViewTransition!(() => new Promise<void>((done) => {
        finish = done
        resolve()
      }))
      void transition.finished.catch(() => undefined).finally(() => {
        root.classList.remove(PAGE_CHANGING)
        if (finish) settle()
      })
    })
  })
  router.afterEach((_to, _from, failure) => {
    if (failure) before = null
    else riseIn()
    settle()
  })
  router.onError(() => {
    before = null
    settle()
  })
}

/** What the shell's main column holds: the routed page's roots beside the shell's own layers, which never change with the page. */
function pageRoots(): Element[] {
  return [...document.querySelectorAll('.app-main > *')]
}

function enter(root: Element) {
  root.classList.add(PAGE_ENTER)
  const done = (event: Event) => {
    if (event.target !== root) return
    root.classList.remove(PAGE_ENTER)
    root.removeEventListener('animationend', done)
    root.removeEventListener('animationcancel', done)
  }
  root.addEventListener('animationend', done)
  root.addEventListener('animationcancel', done)
}
