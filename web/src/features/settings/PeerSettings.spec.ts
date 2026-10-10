import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function open(wrapper: ReturnType<typeof mount>) {
  const details = wrapper.get('details')
  ;(details.element as HTMLDetailsElement).open = true
  await details.trigger('toggle')
  await flushPromises()
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

it('loads only when opened and hosts without enabling console LAN access', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(off))
    .mockResolvedValueOnce(json(paired))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerSettings)
  expect(fetch).not.toHaveBeenCalled()
  await open(wrapper)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer')
  await wrapper.get('[data-host-peer]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/coordinator')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ host: '192.168.1.8', port: 0 })
  expect(wrapper.text()).toContain('共享项目组长')
  expect(wrapper.text()).toContain('AAAA BBBB CCCC DDDD EEEE FFFF')
  wrapper.unmount()
})

it('requires an explicit client when sharing a project lead and never publishes a folder', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(paired))
    .mockResolvedValueOnce(json({ ...paired, shares: [{
      projectId: 'sample-project', projectName: 'Sample project', agentId: 'lead', clients: ['codex'],
      workingDirectory: '/local/only', state: 'shared',
    }] }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerSettings)
  await open(wrapper)
  const project = wrapper.get('.peer-share-title input')
  expect((project.element as HTMLInputElement).checked).toBe(false)
  await project.setValue(true)
  const clients = wrapper.findAll('.peer-shares fieldset input')
  expect((clients[0]!.element as HTMLInputElement).checked).toBe(true)
  expect((clients[1]!.element as HTMLInputElement).checked).toBe(false)
  await wrapper.get('.peer-shares input[type="text"]').setValue('/local/only')
  await wrapper.get('[data-save-shares]').trigger('click')
  await flushPromises()
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
    shares: [{ projectId: 'sample-project', clients: ['codex'], workingDirectory: '/local/only' }],
  })
  expect(wrapper.text()).toContain('本机项目文件夹')
  wrapper.unmount()
})

it('copies a pairing invitation and revokes another device from this computer', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(paired))
    .mockResolvedValueOnce(json({ invitation: 'fuli-peer-invite:1:fixture', fingerprint: 'a'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z' }))
    .mockResolvedValueOnce(json({ ...paired, devices: [] }))
  vi.stubGlobal('fetch', fetch)
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const wrapper = mount(PeerSettings)
  await open(wrapper)
  await wrapper.get('[data-invite-peer]').trigger('click')
  await flushPromises()
  await wrapper.get('[data-copy-invite]').trigger('click')
  expect(writeText).toHaveBeenCalledWith('fuli-peer-invite:1:fixture')
  await wrapper.get(`[data-revoke="${'b'.repeat(64)}"]`).trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[2]?.[0]).toBe(`/api/peer/devices/${'b'.repeat(64)}/revoke`)
  wrapper.unmount()
})

it('previews the device fingerprint before pairing and invalidates it when the invitation changes', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(off))
    .mockResolvedValueOnce(json({ name: 'Other device', url: 'https://192.168.1.9:4101', shortFingerprint: 'ABCD 1234' }))
    .mockResolvedValueOnce(json({ name: 'Other device', url: 'https://192.168.1.9:4101', shortFingerprint: 'ABCD 1234' }))
    .mockResolvedValueOnce(json({ ...paired, role: 'member' }))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerSettings)
  await open(wrapper)
  await wrapper.get('textarea').setValue('first-invitation')
  await wrapper.get('[data-join-peer]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/invitations/preview')
  expect(wrapper.get('[data-invitation-preview]').text()).toContain('ABCD 1234')
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
