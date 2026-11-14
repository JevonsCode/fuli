import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { adoptShownAreas } from '@/features/advanced-areas/advanced-areas'
import AgentDelegationSettings from './AgentDelegationSettings.vue'

const EVERY_AREA = ['roundtable', 'tonborg', 'tidy', 'lan'] as const

// rec#11 D-81, synthetic data only.
const IDS = ['settings', 'organisation', 'projects', 'services_apps', 'roundtable', 'decisions', 'lan_roundtable', 'model_settings', 'public_projects']
const OFF = new Set(['lan_roundtable', 'model_settings', 'public_projects'])
const policy = (changes: Record<string, boolean> = {}, operations: unknown[] = []) => ({
  categories: IDS.map(id => ({ id, defaultEnabled: !OFF.has(id), enabled: changes[id] ?? !OFF.has(id) })),
  updatedAt: null,
  operations,
})
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// An installation that has used every advanced area, unless a test says otherwise.
beforeEach(() => adoptShownAreas([...EVERY_AREA]))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = '' })

function server(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => json(routes[`${init?.method ?? 'GET'} ${url}`]))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('leaves out the 圆桌 and LAN categories until those areas are shown', async () => {
  adoptShownAreas(['tidy'])
  server({ 'GET /api/agent-delegation': policy() })
  const wrapper = mount(AgentDelegationSettings, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.findAll('[data-delegation-category]').map(row => row.attributes('data-delegation-category')))
    .toEqual(IDS.filter(id => id !== 'roundtable' && id !== 'lan_roundtable'))
  adoptShownAreas(['roundtable', 'lan'])
  await flushPromises()
  expect(wrapper.findAll('[data-delegation-category]').map(row => row.attributes('data-delegation-category'))).toEqual(IDS)
})

it('shows one switch per category as a plain card and saves a switch at once', async () => {
  const fetch = server({
    'GET /api/agent-delegation': policy(),
    'PUT /api/agent-delegation/categories/lan_roundtable': policy({ lan_roundtable: true }),
  })
  const wrapper = mount(AgentDelegationSettings, { attachTo: document.body })
  await flushPromises()
  expect(wrapper.find('details').exists()).toBe(false)
  expect(wrapper.get('[data-slot="card-title"]').text()).toBe('AI 权限')
  expect(wrapper.findAll('[data-delegation-category]').map(row => row.attributes('data-delegation-category'))).toEqual(IDS)
  const lan = wrapper.get('[data-delegation-category="lan_roundtable"]')
  expect(lan.text()).toContain('默认关闭')
  for (const row of wrapper.findAll('[data-delegation-category] small')) expect(row.text().length).toBeLessThanOrEqual(100)
  expect(lan.get('[role="switch"]').attributes('aria-checked')).toBe('false')
  await lan.get('[role="switch"]').trigger('click')
  await flushPromises()
  const put = fetch.mock.calls.find(([url, init]) => init?.method === 'PUT' && url === '/api/agent-delegation/categories/lan_roundtable')
  expect(JSON.parse(String(put?.[1]?.body))).toEqual({ enabled: true })
  expect(wrapper.get('[data-delegation-category="lan_roundtable"] [role="switch"]').attributes('aria-checked')).toBe('true')
  wrapper.unmount()
})

it('lists what always stays the person\'s and the latest changes with their undo in 「查看详情」', async () => {
  server({ 'GET /api/agent-delegation': policy({}, [{ id: 'op-1', at: '2026-11-03T08:00:00.000Z', route: 'PATCH /api/recall-policy',
    path: '/api/recall-policy', category: 'settings', actor: { agentId: 'fla-synthetic', projectId: null, client: 'codex', sessionId: 's' },
    reason: 'Asked to turn it off', bodyFields: ['answerFromConfirmed'], status: 200, outcome: 'succeeded', undo: 'Set answerFromConfirmed back.', relayed: null }, {
    id: 'op-2', at: '2026-11-04T08:00:00.000Z', route: 'POST /api/judgment/feedback', path: '/api/judgment/feedback', category: 'decisions',
    actor: { agentId: 'fla-synthetic', projectId: null, client: 'codex', sessionId: 's' }, reason: 'Relayed the vote',
    bodyFields: ['vote'], status: 200, outcome: 'succeeded', undo: 'Vote again; every earlier vote and reason is kept.',
    relayed: { words: '这条判断不对', messageRef: { taskId: 't', conversationId: null, at: null } } }]) })
  const wrapper = mount(AgentDelegationSettings, { attachTo: document.body })
  await flushPromises()
  await wrapper.get('[data-agent-delegation-details]').trigger('click')
  await flushPromises()
  const dialog = document.querySelector('[data-agent-delegation-dialog]')
  expect(dialog?.textContent).toContain('彻底删除知识')
  expect(dialog?.textContent).toContain('Agent 已确认')
  const operation = dialog?.querySelector('[data-delegated-operation="op-1"]')
  expect(operation?.textContent).toContain('PATCH /api/recall-policy')
  expect(operation?.textContent).toContain('fla-synthetic')
  expect(operation?.textContent).toContain('撤销：Set answerFromConfirmed back.')
  expect(operation?.querySelector('[data-relayed-words]')).toBeNull()
  expect(dialog?.querySelector('[data-delegated-operation="op-2"] [data-relayed-words]')?.textContent).toBe('你的原话：「这条判断不对」')
  expect(dialog?.textContent).toContain('原样转达你的原话')
  wrapper.unmount()
})
