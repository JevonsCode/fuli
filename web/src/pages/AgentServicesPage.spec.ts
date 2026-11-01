import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import AgentServicesPage from './AgentServicesPage.vue'
import type { AgentService } from '@/features/agent-services/agent-services'
import { useConsoleStore } from '@/stores/console'

const service = (overrides: Partial<AgentService> = {}): AgentService => ({
  serviceId: 'svc-1', kind: 'agent_service', personalSpaceId: 'space-1', agentId: 'fla-a', projectId: 'project-a',
  client: 'claude_code', sessionId: 'session-12345678', appId: null, address: 'http://localhost:5173', purpose: 'Docs preview',
  command: 'npm run dev', pid: 4100, executable: 'C:\\node\\node.exe', commandLine: 'node vite --port 5173', state: 'running',
  startedAt: '2026-10-27T08:00:00Z', stoppedAt: null, stopReason: null, live: { state: 'running', process: 'alive', port: 'open' }, ...overrides,
})

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
function serve(routes: Record<string, (body?: Record<string, unknown>) => Response | unknown>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body })
    const key = Object.keys(routes).find(prefix => `${method} ${url}`.startsWith(prefix))
    const value = key ? routes[key](body) : undefined
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value ?? {}), { status: value === undefined ? 404 : 200 })
  }))
}

let router: ReturnType<typeof createRouter>
async function mountPage(path = '/project-agents/services') {
  const store = useConsoleStore()
  Object.assign(store, { state: { personalProjects: [{ project_id: 'project-a', profile: { name: 'Alpha' } }] } })
  vi.spyOn(store, 'activePersonalSpace', 'get').mockReturnValue({ id: 'space-1' } as never)
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  const wrapper = mount(AgentServicesPage, { attachTo: document.body, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}
// Log, stop and delete sit under the row's disclosure.
async function rowAction(wrapper: Awaited<ReturnType<typeof mountPage>>, row: string, item: string) {
  await wrapper.get(`[data-service-row="${row}"] [data-service-toggle]`).trigger('click')
  await wrapper.get(`[data-service-row="${row}"] ${item}`).trigger('click')
  await flushPromises()
}
const inBody = (selector: string) => document.querySelector(selector) as HTMLElement

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const listed = [service(), service({ serviceId: 'svc-2', agentId: 'fla-b', kind: 'workbench', client: 'fuli', projectId: null,
  purpose: 'Dispatch log', address: null, live: { state: 'stopped', process: 'gone', port: 'not_checked' }, state: 'stopped' })]

describe('services page', () => {
  it('groups services by live state, opens a running address, folds the details and searches from the URL', async () => {
    serve({
      'GET /api/agent-services': () => ({ services: listed, checkedAt: '2026-10-27T08:01:00Z' }),
      'GET /api/project-agents?': () => ({ agents: [{ agent_id: 'fla-a', personal_space_id: 'space-1', profile: { name: 'Builder' } }] }),
    })
    const wrapper = await mountPage()
    expect(wrapper.get('[data-service-group="running"]').text()).toContain('运行中')
    expect(wrapper.get('[data-service-group="stopped"]').text()).toContain('已停止')
    const row = wrapper.get('[data-service-group="running"] [data-service-row="svc-1"]')
    expect(row.text()).toContain('Docs preview')
    expect(row.text()).toContain('http://localhost:5173')
    expect(row.get('[data-service-open]').attributes('href')).toBe('http://localhost:5173')
    expect(wrapper.find('[data-service-row="svc-2"] [data-service-open]').exists()).toBe(false)
    expect(row.find('[data-service-detail]').exists()).toBe(false)

    await row.get('[data-service-toggle]').trigger('click')
    const detail = row.get('[data-service-detail]').text()
    expect(detail).toContain('Builder · Alpha')
    expect(detail).toContain('4100')
    expect(detail).toContain('node vite --port 5173')
    expect(row.get('[data-service-state]').text()).toBe('进程在运行 · 端口可连接')
    expect(row.get('[data-service-toggle]').attributes('aria-expanded')).toBe('true')

    await router.replace({ query: { q: 'docs' } })
    await flushPromises()
    expect(wrapper.findAll('[data-service-row]').map(item => item.attributes('data-service-row'))).toEqual(['svc-1'])
  })

  it('shows the exact PID and command before stopping, and sends that PID back', async () => {
    serve({
      'GET /api/agent-services': () => ({ services: listed, checkedAt: '2026-10-27T08:01:00Z' }),
      'GET /api/project-agents?': () => ({ agents: [] }),
      'POST /api/agent-services/svc-1/stop': () => ({ status: 'stopped' }),
    })
    const wrapper = await mountPage()
    await rowAction(wrapper, 'svc-1', '[data-service-stop]')
    const identity = inBody('[data-service-stop-identity]').textContent ?? ''
    expect(identity).toContain('4100')
    expect(identity).toContain('node vite --port 5173')
    inBody('[data-service-stop-confirm]').click()
    await flushPromises()
    expect(calls.find(call => call.method === 'POST')).toEqual({ url: '/api/agent-services/svc-1/stop', method: 'POST', body: { pid: 4100 } })
  })

  it('reads a log and clears it only after a second click', async () => {
    const entries = [{ id: 1, at: '2026-10-27T08:00:00Z', action: 'registered', actor: 'agent', detail: { pid: 4100 } }]
    serve({
      'GET /api/agent-services/svc-1/log': () => ({ serviceId: 'svc-1', entries, liveOutput: null }),
      'GET /api/agent-services': () => ({ services: listed, checkedAt: '2026-10-27T08:01:00Z' }),
      'GET /api/project-agents?': () => ({ agents: [] }),
      'DELETE /api/agent-services/svc-1/log': () => { entries.length = 0; return { status: 'cleared' } },
    })
    const wrapper = await mountPage()
    await rowAction(wrapper, 'svc-1', '[data-service-log-open]')
    expect(inBody('[data-service-log-entry="registered"]').textContent).toContain('登记')
    inBody('[data-service-log-clear]').click()
    await flushPromises()
    expect(calls.some(call => call.method === 'DELETE')).toBe(false)
    inBody('[data-service-log-clear-confirm]').click()
    await flushPromises()
    expect(calls.some(call => call.method === 'DELETE' && call.url === '/api/agent-services/svc-1/log')).toBe(true)
    expect(inBody('[data-service-log]').textContent).toContain('日志是空的')

  })

  it('deletes a record after confirming', async () => {
    serve({
      'GET /api/agent-services': () => ({ services: listed, checkedAt: '2026-10-27T08:01:00Z' }),
      'GET /api/project-agents?': () => ({ agents: [] }),
      'DELETE /api/agent-services/svc-2': () => ({ status: 'deleted' }),
    })
    const wrapper = await mountPage()
    await rowAction(wrapper, 'svc-2', '[data-service-delete]')
    inBody('[data-service-delete-confirm]').click()
    await flushPromises()
    expect(calls.some(call => call.method === 'DELETE' && call.url === '/api/agent-services/svc-2')).toBe(true)
    expect(wrapper.find('[data-service-row="svc-2"]').exists()).toBe(false)
  })
})
