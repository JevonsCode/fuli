import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { openCombobox, optionLabels, toggleOption } from '@/test-support/option-pickers'
import PeerSettings from './PeerSettings.vue'

const off = {
  beta: true, role: null, device: null, coordinator: null, addresses: ['192.168.1.8'],
  devices: [], openInvitations: 0, shares: [], shareable: [],
}
const paired = {
  beta: true, role: 'coordinator',
  device: { fingerprint: 'a'.repeat(64), shortFingerprint: 'AAAA BBBB CCCC DDDD EEEE FFFF' },
  coordinator: { name: 'Desk', url: 'https://192.168.1.8:4101', shortFingerprint: 'AAAA BBBB CCCC DDDD EEEE FFFF', listening: true },
  addresses: ['192.168.1.8'],
  devices: [{ nodeId: 'b'.repeat(64), name: 'Laptop', shortFingerprint: 'BBBB CCCC DDDD EEEE FFFF 0000', status: 'active', online: true }],
  openInvitations: 0,
  shares: [],
  shareable: [{ projectId: 'sample-project', projectName: 'Sample project', lead: { agentId: 'lead', name: 'Shared lead' },
    clients: ['codex', 'claude_code'] }],
}
const sharedSample = { projectId: 'sample-project', projectName: 'Sample project', agentId: 'lead', clients: ['codex'], state: 'shared' }
const noResults = { projects: [], more: false }

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Answers each route (method and path, without the query) from its own queue;
// the last answer of a queue repeats. Every call is kept as [url, init].
function server(routes: Record<string, unknown[]>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    const queue = routes[key] ?? (key.startsWith('GET /api/peer/shareable') && !key.startsWith('GET /api/peer/shareable/') ? [noResults] : undefined)
    if (!queue?.length) throw new Error(`Unexpected request ${key}`)
    return json(queue.length > 1 ? queue.shift() : queue[0])
  })
  vi.stubGlobal('fetch', fetch)
  const calls = (key: string) => fetch.mock.calls.filter(([url, init]) => `${init?.method ?? 'GET'} ${url.split('?')[0]}` === key)
  return { fetch, calls }
}

const body = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))

it('loads as a plain card and hosts without enabling console LAN access', async () => {
  const { fetch } = server({ 'GET /api/peer': [off], 'POST /api/peer/coordinator': [paired] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect(wrapper.find('details').exists()).toBe(false)
  expect(wrapper.get('[data-slot="card-title"]').text()).toBe('局域网圆桌（Beta）')
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer')
  await wrapper.get('[data-host-peer]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/coordinator')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ host: '192.168.1.8', port: 0 })
  expect(wrapper.text()).toContain('共享项目组长')
  expect(wrapper.text()).toContain('AAAA BBBB CCCC DDDD EEEE FFFF')
  wrapper.unmount()
})

it('shows the short list as one line per project and requires an explicit client, never publishing a folder', async () => {
  const { calls } = server({ 'GET /api/peer': [paired], 'PUT /api/peer/shares': [{ ...paired, shares: [{ ...sharedSample, workingDirectory: '/local/only' }] }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  const title = wrapper.get('.peer-share-title')
  expect(title.text()).toContain('Sample project')
  expect(title.text()).toContain('当前组长 Shared lead')
  expect(title.attributes('title')).toBe('Sample project · 当前组长 Shared lead')
  expect(wrapper.find('.peer-shares fieldset').exists()).toBe(false)
  const project = wrapper.get('.peer-share-title input')
  expect((project.element as HTMLInputElement).checked).toBe(false)
  await project.setValue(true)
  const clients = wrapper.findAll('.peer-shares fieldset input')
  expect((clients[0]!.element as HTMLInputElement).checked).toBe(true)
  expect((clients[1]!.element as HTMLInputElement).checked).toBe(false)
  await wrapper.get('.peer-shares input[type="text"]').setValue('/local/only')
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({
    shares: [{ projectId: 'sample-project', clients: ['codex'], workingDirectory: '/local/only' }],
  })
  expect(wrapper.text()).toContain('本机项目文件夹')
  wrapper.unmount()
})

it('searches other projects as the person types, adds the picked one as a ticked row and saves it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const picked = { projectId: 'other-project', projectName: 'Other project', lead: { agentId: 'other-lead', name: 'Other lead' },
    clients: ['claude_code', 'codex'], sameProjectOn: [], knownFolder: null }
  const { calls } = server({
    'GET /api/peer': [paired],
    'GET /api/peer/shareable': [{ projects: [{ projectId: 'recent-project', projectName: 'Recent project' }], more: false },
      { projects: [{ projectId: 'other-project', projectName: 'Other project' }], more: true }],
    'GET /api/peer/shareable/other-project': [picked],
    'PUT /api/peer/shares': [{ ...paired, shares: [{ ...sharedSample, projectId: 'other-project' }],
      shareable: [...paired.shareable, picked] }],
  })
  const wrapper = mount(PeerSettings, { attachTo: document.body })
  await flushPromises()
  const picker = wrapper.get('[data-peer-share-picker]')
  expect(calls('GET /api/peer/shareable')[0]?.[0]).toBe('/api/peer/shareable?query=&limit=20')
  await openCombobox(picker)
  expect(optionLabels(picker)).toEqual(['Recent project'])
  await picker.get('input[role="combobox"]').setValue('Other')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  expect(calls('GET /api/peer/shareable')[1]?.[0]).toBe('/api/peer/shareable?query=Other&limit=20')
  expect(optionLabels(picker)).toEqual(['Other project'])
  expect(document.body.textContent).toContain('还有更多，接着输入')
  await toggleOption(picker, 'Other project')
  await flushPromises()
  expect(calls('GET /api/peer/shareable/other-project')).toHaveLength(1)
  const row = wrapper.get('[data-share-row="other-project"]')
  expect((row.get('.peer-share-title input').element as HTMLInputElement).checked).toBe(true)
  expect(row.findAll('fieldset input').map((input) => (input.element as HTMLInputElement).checked)).toEqual([true, false])
  expect(calls('PUT /api/peer/shares')).toHaveLength(0)
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({ shares: [{ projectId: 'other-project', clients: ['claude_code'] }] })
  wrapper.unmount()
})

it('keeps a row added in this visit after it is unticked, until the save', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const picked = { projectId: 'other-project', projectName: 'Other project', lead: { agentId: 'other-lead', name: 'Other lead' },
    clients: ['codex'], sameProjectOn: [], knownFolder: null }
  const { calls } = server({
    'GET /api/peer': [paired],
    'GET /api/peer/shareable': [{ projects: [{ projectId: 'other-project', projectName: 'Other project' }], more: false }],
    'GET /api/peer/shareable/other-project': [picked],
    'PUT /api/peer/shares': [paired],
  })
  const wrapper = mount(PeerSettings, { attachTo: document.body })
  await flushPromises()
  const picker = wrapper.get('[data-peer-share-picker]')
  await openCombobox(picker)
  await toggleOption(picker, 'Other project')
  await flushPromises()
  await wrapper.get('[data-share-row="other-project"] .peer-share-title input').setValue(false)
  expect(wrapper.find('[data-share-row="other-project"]').exists()).toBe(true)
  await openCombobox(picker)
  expect(optionLabels(picker)).toEqual([])
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({ shares: [] })
  expect(wrapper.find('[data-share-row="other-project"]').exists()).toBe(false)
  wrapper.unmount()
})

it('says nothing was found when the search is empty', async () => {
  server({ 'GET /api/peer': [{ ...paired, shareable: [] }] })
  const wrapper = mount(PeerSettings, { attachTo: document.body })
  await flushPromises()
  const picker = wrapper.get('[data-peer-share-picker]')
  await openCombobox(picker)
  expect(document.body.textContent).toContain('没有找到')
  wrapper.unmount()
})

it('with nothing shared and nothing suggested shows one sentence and the add control, not an empty list', async () => {
  server({ 'GET /api/peer': [{ ...paired, shareable: [] }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect(wrapper.get('[data-shares-empty]').text()).toBe('还没有共享的项目。可以在下面添加。')
  expect(wrapper.find('.peer-shares').exists()).toBe(false)
  expect(wrapper.find('[data-save-shares]').exists()).toBe(false)
  expect(wrapper.find('[data-peer-share-picker]').exists()).toBe(true)
  wrapper.unmount()
})

it('unticking a saved share and saving removes it', async () => {
  const sharedStatus = { ...paired, shares: [sharedSample] }
  const { calls } = server({ 'GET /api/peer': [sharedStatus], 'PUT /api/peer/shares': [{ ...paired, shareable: [] }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  const project = wrapper.get('.peer-share-title input')
  expect((project.element as HTMLInputElement).checked).toBe(true)
  await project.setValue(false)
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({ shares: [] })
  wrapper.unmount()
})

it('copies a pairing invitation and revokes another device from this computer', async () => {
  const { fetch } = server({
    'GET /api/peer': [paired],
    'POST /api/peer/invitations': [{ invitation: 'fuli-peer-invite:1:fixture', fingerprint: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z' }],
    [`POST /api/peer/devices/${'b'.repeat(64)}/revoke`]: [{ ...paired, devices: [] }],
  })
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  await wrapper.get('[data-invite-peer]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-copy-invite]').trigger('click')
  expect(writeText).toHaveBeenCalledWith('fuli-peer-invite:1:fixture')
  await wrapper.get(`[data-revoke="${'b'.repeat(64)}"]`).trigger('click')
  await flushPromises()
  expect(fetch.mock.calls.some(([url]) => url === `/api/peer/devices/${'b'.repeat(64)}/revoke`)).toBe(true)
  wrapper.unmount()
})

it('shows the fingerprint of the other computer only on a computer that joined one', async () => {
  server({ 'GET /api/peer': [paired] })
  const host = mount(PeerSettings)
  await flushPromises()
  expect(host.find('[data-other-fingerprint]').exists()).toBe(false)
  host.unmount()
  server({ 'GET /api/peer': [{ ...paired, role: 'member', devices: [],
    coordinator: { ...paired.coordinator, shortFingerprint: 'BBBB CCCC DDDD EEEE FFFF 0000' } }] })
  const member = mount(PeerSettings)
  await flushPromises()
  expect(member.get('[data-other-fingerprint]').text()).toContain('BBBB CCCC DDDD EEEE FFFF 0000')
  member.unmount()
})

it('suggests a project a paired computer has too, shares nothing until the person ticks it, then offers the known checkout', async () => {
  const matched = { ...paired, shareable: [{ ...paired.shareable[0], sameProjectOn: [{ nodeId: 'b'.repeat(64), name: 'Laptop' }],
    knownFolder: '/synthetic/checkout' }], lastPublish: { at: '2030-01-01T00:00:00.000Z', agents: null, error: 'coordinator_unreachable' } }
  const { calls } = server({ 'GET /api/peer': [matched], 'PUT /api/peer/shares': [paired] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect((wrapper.get('.peer-share-title input').element as HTMLInputElement).checked).toBe(false)
  expect(wrapper.get('[data-same-project]').text()).toContain('Laptop 上也有这个项目')
  expect(wrapper.get('[data-publish-error]').text()).toContain('coordinator_unreachable')
  await wrapper.get('.peer-share-title input').setValue(true)
  expect((wrapper.get('.peer-shares input[type="text"]').element as HTMLInputElement).value).toBe('/synthetic/checkout')
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({
    shares: [{ projectId: 'sample-project', clients: ['codex'], workingDirectory: '/synthetic/checkout' }],
  })
  wrapper.unmount()
})

it('shares every common project not shared yet with one click, keeping what is already shared', async () => {
  const laptop = [{ nodeId: 'b'.repeat(64), name: 'Laptop' }]
  const status = { ...paired, shares: [sharedSample], shareable: [
    { ...paired.shareable[0], sameProjectOn: laptop },
    { projectId: 'common-a', projectName: 'Common A', lead: { agentId: 'a', name: 'A lead' }, clients: ['claude_code'], sameProjectOn: laptop, knownFolder: '/synthetic/a' },
    { projectId: 'common-b', projectName: 'Common B', lead: { agentId: 'b', name: 'B lead' }, clients: ['codex'], sameProjectOn: laptop, knownFolder: null },
  ] }
  const { calls } = server({ 'GET /api/peer': [status], 'PUT /api/peer/shares': [status] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect(wrapper.get('[data-share-suggestions]').text()).toBe('共享这 2 个相同的项目')
  await wrapper.get('[data-share-suggestions]').trigger('click')
  await flushPromises()
  expect(body(calls('PUT /api/peer/shares')[0])).toEqual({ shares: [
    { projectId: 'sample-project', clients: ['codex'] },
    { projectId: 'common-a', clients: ['claude_code'], workingDirectory: '/synthetic/a' },
    { projectId: 'common-b', clients: ['codex'] },
  ] })
  wrapper.unmount()
})

it('says when the coordinator is not listening and why', async () => {
  server({ 'GET /api/peer': [{ ...paired, coordinator: { ...paired.coordinator, listening: false,
    listenFailure: { address: '10.255.255.1', port: 4101, code: 'EADDRNOTAVAIL', at: '2030-01-01T00:00:00.000Z' } } }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect(wrapper.get('[data-listen-failure]').text()).toContain('没能在 10.255.255.1 上监听（EADDRNOTAVAIL）')
  wrapper.unmount()
})

it('says when no checkout of the project is known here', async () => {
  server({ 'GET /api/peer': [{ ...paired, shareable: [{ ...paired.shareable[0],
    sameProjectOn: [{ nodeId: 'b'.repeat(64), name: 'Laptop' }], knownFolder: null }] }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  await wrapper.get('.peer-share-title input').setValue(true)
  expect(wrapper.find('[data-folder-unknown]').exists()).toBe(true)
  wrapper.unmount()
})

it('previews the device fingerprint before pairing, says what joining shares, and invalidates it when the invitation changes', async () => {
  const preview = { name: 'Other device', url: 'https://192.168.1.9:4101', shortFingerprint: 'ABCD 1234' }
  const { fetch } = server({ 'GET /api/peer': [off], 'POST /api/peer/invitations/preview': [preview], 'POST /api/peer/join': [{ ...paired, role: 'member' }] })
  const wrapper = mount(PeerSettings)
  await flushPromises()
  expect(wrapper.find('[data-share-on-pair]').exists()).toBe(false)
  await wrapper.get('textarea').setValue('first-invitation')
  await wrapper.get('[data-join-peer]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/invitations/preview')
  expect(wrapper.get('[data-invitation-preview]').text()).toContain('ABCD 1234')
  expect(wrapper.get('[data-share-on-pair]').text()).toBe('确认后，两台电脑上相同的项目的负责人可以直接互相提问。其他项目不会共享。')
  expect(fetch.mock.calls.some(([url]) => url === '/api/peer/join')).toBe(false)
  await wrapper.get('textarea').setValue('replacement-invitation')
  expect(wrapper.find('[data-invitation-preview]').exists()).toBe(false)
  await wrapper.get('[data-join-peer]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-join-peer]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[3]?.[0]).toBe('/api/peer/join')
  expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({ invitation: 'replacement-invitation' })
  wrapper.unmount()
})
