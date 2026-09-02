import { shallowRef } from 'vue'
import type { Router } from 'vue-router'

export const navigationFailure = shallowRef<{ href: string; resourceFailure: boolean } | null>(null)

// A deployment can remove a lazy-loaded chunk while an older tab is still open.
// Keep the current page intact; only an explicit user action reloads the document.
export function installNavigationRecovery(router: Router) {
  const stopErrors = router.onError((error, destination) => {
    const href = router.resolve(destination).href
    if (!href.startsWith('/') || href.startsWith('//')) return
    navigationFailure.value = {
      href,
      resourceFailure: /dynamically imported module|module script|loading chunk|preload css|importing a module/i.test(String(error)),
    }
  })
  const stopNavigation = router.afterEach((_to, _from, failure) => {
    if (!failure) navigationFailure.value = null
  })
  return () => { stopErrors(); stopNavigation() }
}
