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

/** On the root element while a page transition runs (styles/motion.css). */
export const PAGE_CHANGING = 'is-page-changing'

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void>) => { finished: Promise<void> } }

/**
 * Page changes cross-fade and rise through the View Transitions API, so no
 * page needs a single root or its own wrapper. A query or hash change on the
 * same path (an in-page tab) does not animate; neither does anything while
 * motion is reduced, nor a browser without the API.
 */
export function installPageTransitions(router: Router) {
  let finish: (() => void) | null = null
  const settle = () => {
    const done = finish
    finish = null
    if (done) void nextTick(done)
  }
  router.beforeResolve((to, from) => {
    const doc = document as ViewTransitionDocument
    if (!doc.startViewTransition || motionReduced() || !from.matched.length || to.path === from.path) return
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
  router.afterEach(settle)
  router.onError(settle)
}
