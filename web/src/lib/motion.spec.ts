import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { installPageTransitions, motionConfigReduced } from './motion'
import { setMotionPreference } from './motion-preference'

const page = { template: '<div />' }
function router() {
  const value = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: page }, { path: '/a', component: page }] })
  installPageTransitions(value)
  return value
}

describe('page transitions', () => {
  let start: ReturnType<typeof vi.fn>
  beforeEach(() => {
    setMotionPreference('system')
    start = vi.fn((update: () => Promise<void>) => ({ finished: update() }))
    Object.assign(document, { startViewTransition: start })
  })

  it('wraps a change of page in one view transition and finishes it after the new page renders', async () => {
    const app = router()
    await app.push('/')
    expect(start).not.toHaveBeenCalled()
    await app.push('/a')
    expect(start).toHaveBeenCalledOnce()
  })

  it('leaves an in-page query change and reduced motion alone', async () => {
    const app = router()
    await app.push('/')
    await app.push('/a')
    await app.push({ path: '/a', query: { tab: 'history' } })
    expect(start).toHaveBeenCalledOnce()
    setMotionPreference('reduced')
    await app.push('/')
    expect(start).toHaveBeenCalledOnce()
    expect(motionConfigReduced.value).toBe('always')
  })

  it('navigates normally where the browser has no view transitions', async () => {
    Object.assign(document, { startViewTransition: undefined })
    const app = router()
    await app.push('/')
    await app.push('/a')
    expect(app.currentRoute.value.path).toBe('/a')
  })
})
