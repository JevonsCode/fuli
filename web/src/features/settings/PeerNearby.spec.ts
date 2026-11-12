import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import PeerNearby from './PeerNearby.vue'
import { groupedCode, pairingOutcome, type Nearby, type NearbyPairing } from './peer-model'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const answer = (nearby: Nearby) => ({ beta: true, role: 'coordinator', device: null, coordinator: null, addresses: [], devices: [],
  openInvitations: 0, shares: [], shareable: [], nearby })
const off: Nearby ={ on: false, name: null, suggestedName: 'Desk', canPair: false, reason: null, devices: [], pairing: null }
const listed: Nearby = { ...off, on: true, name: 'Desk', canPair: true,
  devices: [{ name: 'Laptop', fingerprint: 'abcd123456789abc', shortFingerprint: 'ABCD 1234 5678 9ABC', paired: false }] }
const waiting: NearbyPairing = { requestId: 'request-1', direction: 'outgoing', state: 'confirm', reason: null,
  device: { name: 'Laptop', shortFingerprint: 'ABCD 1234 5678 9ABC' }, code: '042917', coordinator: 'other',
  confirmedHere: false, confirmedThere: false, expiresAt: '2030-01-01T00:02:00.000Z' }

it('says what turning it on shows the network, and sends the chosen name', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(answer(listed)))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerNearby, { props: { nearby: off, coordinatorName: null } })
  expect(wrapper.text()).toContain('同一网络里的设备能看到这台电脑装了 FULI')
  expect((wrapper.get('[data-nearby-name]').element as HTMLInputElement).value).toBe('Desk')
  await wrapper.get('[data-nearby-name]').setValue('Studio')
  await wrapper.get('[data-nearby-switch]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer/nearby')
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ on: true, name: 'Studio' })
  expect(wrapper.emitted('status')?.[0]?.[0]).toMatchObject({ nearby: { on: true } })
})

it('pairs from the list, shows the code and confirms the code shown here', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(answer({ ...listed, pairing: waiting })))
    .mockResolvedValueOnce(json(answer({ ...listed, pairing: { ...waiting, confirmedHere: true } })))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerNearby, { props: { nearby: listed, coordinatorName: 'Desk' } })
  await wrapper.get('[data-nearby-pair="abcd123456789abc"]').trigger('click')
  await flushPromises()
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ fingerprint: 'abcd123456789abc' })
  await wrapper.setProps({ nearby: { ...listed, pairing: waiting } })
  expect(wrapper.get('[data-pairing-code]').text()).toContain('042 917')
  expect(wrapper.text()).toContain('配对后由 Laptop 负责协调')
  await wrapper.get('[data-pairing-confirm]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/nearby/confirm')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ requestId: 'request-1', code: '042917' })
})

it('says how a pairing ended, and that a member pairs through its coordinator', async () => {
  const wrapper = mount(PeerNearby, { props: { nearby: { ...listed, canPair: false,
    pairing: { ...waiting, state: 'failed', reason: 'code_mismatch', code: null } }, coordinatorName: 'Laptop' } })
  expect(wrapper.get('[data-pairing-outcome]').text()).toContain('两边的数字不一致')
  expect(wrapper.text()).toContain('新电脑请在 Laptop 上配对')
  expect(wrapper.get('[data-nearby-pair="abcd123456789abc"]').attributes('disabled')).toBeDefined()
})

it('reads codes in two groups and maps each ending to one message', () => {
  expect(groupedCode('042917')).toBe('042 917')
  expect(pairingOutcome({ ...waiting, state: 'paired' })).toBe('paired')
  expect(pairingOutcome({ ...waiting, state: 'expired' })).toBe('expired')
  expect(pairingOutcome({ ...waiting, state: 'cancelled', reason: 'cancelled_there' })).toBe('cancelled')
  expect(pairingOutcome({ ...waiting, state: 'failed', reason: 'coordinator_unreachable' })).toBe('failed')
  expect(pairingOutcome(waiting)).toBe(null)
})
