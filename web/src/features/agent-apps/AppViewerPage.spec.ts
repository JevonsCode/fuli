import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

const { default: AppViewerPage } = await import('./AppViewerPage.vue')

// Synthetic app only.
const app = (patch: Record<string, unknown> = {}) => ({
  appId: 'app-page', agentId: 'agent-a', name: 'app-page', status: 'active', version: '1.0.0', run: { status: 'ready' }, instance: null, dataBytes: 0,
  versions: [{ version: '1.0.0', state: 'approved', digest: 'sha256:synthetic', title: 'Synthetic page', type: 'page', permissions: {}, resident: false, approval: null }],
  history: [], ...patch,
})

async function mountViewer() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/project-agents/apps/:appId', component: AppViewerPage }, { path: '/:path(.*)*', component: { render: () => null } }] })
  await router.push('/project-agents/apps/app-page')
  const wrapper = mount({ template: '<RouterView />' }, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

afterEach(() => getJson.mockReset())

describe('a page app inside FULI', () => {
  it('runs in a sandboxed frame with scripts and forms only, never the console’s origin', async () => {
    getJson.mockResolvedValue(app())
    const frame = (await mountViewer()).get('[data-app-frame]')
    expect(frame.attributes('src')).toBe('/app-pages/app-page/')
    expect(frame.attributes('sandbox')).toBe('allow-scripts allow-forms')
    expect(frame.attributes('sandbox')).not.toContain('allow-same-origin')
    expect(frame.attributes('title')).toBe('Synthetic page')
  })

  it('does not load the page while the app needs confirming', async () => {
    getJson.mockResolvedValue(app({ run: { status: 'run_refused', reason: 'confirmation_required' } }))
    const wrapper = await mountViewer()
    expect(wrapper.find('[data-app-frame]').exists()).toBe(false)
    expect(wrapper.get('[data-app-viewer-blocked]').text()).toContain('先在应用详情里确认它')
  })
})
