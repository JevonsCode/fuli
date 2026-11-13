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
const off: Nearby = { on: false, name: null, suggestedName: 'FULI 9BA9', canPair: false, reason: null, devices: [], pairing: null }
const listed: Nearby = { ...off, on: true, name: 'Desk', canPair: true,
  devices: [{ name: 'Laptop', fingerprint: 'abcd123456789abc', shortFingerprint: 'ABCD 1234 5678 9ABC', paired: false }] }
const waiting: NearbyPairing = { requestId: 'request-1', direction: 'outgoing', state: 'confirm', reason: null,
  device: { name: 'Laptop', shortFingerprint: 'ABCD 1234 5678 9ABC' }, code: '042917', coordinator: 'other',
  confirmedHere: false, confirmedThere: false, expiresAt: '2030-01-01T00:02:00.000Z' }

it('says what turning it on shows the network, suggests a name that is not the computer name, and sends the chosen one', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(answer(listed)))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerNearby, { props: { nearby: off, coordinatorName: null } })
  expect(wrapper.text()).toContain('同一网络里的设备能看到这台电脑装了 FULI')
  expect(wrapper.get('[data-nearby-name]').attributes('placeholder')).toBe('FULI 9BA9')
  await wrapper.get('[data-nearby-name]').setValue('Studio')
  await wrapper.get('[data-nearby-switch]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer/nearby')
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ on: true, name: 'Studio' })
  expect(wrapper.emitted('status')?.[0]?.[0]).toMatchObject({ nearby: { on: true } })
})

it('confirms only after the person ticked that both screens show the same digits', async () => {
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
  // Said before the confirm control: confirming shares the leads of the projects both computers have.
  expect(wrapper.get('[data-share-on-pair]').text()).toBe('确认后，两台电脑上相同的项目的负责人可以直接互相提问。其他项目不会共享。')
  expect(wrapper.get('[data-pairing-confirm]').attributes('disabled')).toBeDefined()
  await wrapper.get('[data-pairing-confirm]').trigger('click')
  expect(fetch).toHaveBeenCalledTimes(1)
  await wrapper.get('[data-pairing-same]').trigger('click')
  await wrapper.get('[data-pairing-confirm]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/peer/nearby/confirm')
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ requestId: 'request-1', code: '042917' })
})

it('shows who asks to pair the moment a request arrives, and lets the person refuse it', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(answer(listed)))
  vi.stubGlobal('fetch', fetch)
  const asking = { ...waiting, direction: 'incoming' as const, state: 'connecting' as const, code: null,
    device: { name: 'Stranger', shortFingerprint: 'FFFF 0000' } }
  const wrapper = mount(PeerNearby, { props: { nearby: { ...listed, pairing: asking }, coordinatorName: null } })
  expect(wrapper.get('[data-pairing-asked]').text()).toContain('Stranger 想和这台电脑配对')
  expect(wrapper.get('[data-pairing-asked]').text()).toContain('FFFF 0000')
  await wrapper.get('[data-pairing-cancel]').trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer/nearby/cancel')
})

it('says why nearby pairing turned off, when too many requests failed, and how a pairing ended', () => {
  const ended = mount(PeerNearby, { props: { nearby: { ...off, ended: { kind: 'discovery_failed', reason: 'EADDRINUSE', at: 'now' } },
    coordinatorName: null } })
  expect(ended.get('[data-nearby-ended]').text()).toContain('附近发现没能启动：EADDRINUSE')
  const limited = mount(PeerNearby, { props: { nearby: { ...listed, canPair: false, limited: true,
    attempts: { lastWindow: 5, lastDay: 7, limited: true } }, coordinatorName: null } })
  expect(limited.get('[data-nearby-limited]').text()).toContain('10 分钟 5 次，24 小时 7 次')
  expect(limited.get('[data-nearby-pair="abcd123456789abc"]').attributes('disabled')).toBeDefined()
  const mismatch = mount(PeerNearby, { props: { nearby: { ...listed, canPair: false,
    pairing: { ...waiting, state: 'failed', reason: 'code_mismatch', code: null } }, coordinatorName: 'Laptop' } })
  expect(mismatch.get('[data-pairing-outcome]').text()).toContain('两边的数字不一致')
  expect(mismatch.text()).toContain('新电脑请在 Laptop 上配对')
})

it('warns that many attempts can mean an uninvited device, and clears only as a deliberate second step', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(answer({ ...listed, attempts: { lastWindow: 0, lastDay: 0, limited: false } })))
  vi.stubGlobal('fetch', fetch)
  const wrapper = mount(PeerNearby, { props: { nearby: { ...listed, canPair: false, limited: true,
    attempts: { lastWindow: 5, lastDay: 5, limited: true } }, coordinatorName: null } })
  expect(wrapper.get('[data-nearby-limited]').text()).toContain('可能有人在未经邀请地试着配对')
  expect(wrapper.find('[data-nearby-clear]').exists()).toBe(false)
  await wrapper.get('[data-nearby-clear-ask]').trigger('click')
  expect(wrapper.get('[data-nearby-clear-confirm]').text()).toContain('只有确定是你自己')
  await wrapper.get('[data-nearby-clear-keep]').trigger('click')
  expect(wrapper.find('[data-nearby-clear]').exists()).toBe(false)
  await wrapper.get('[data-nearby-clear-ask]').trigger('click')
  await wrapper.get('[data-nearby-clear]').trigger('click')
  await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/peer/nearby/attempts/clear')
})

it('says waiting, not paired, until the other computer first connects', () => {
  const wrapper = mount(PeerNearby, { props: { nearby: { ...listed, pairing: { ...waiting, state: 'waiting', code: null } }, coordinatorName: null } })
  expect(wrapper.get('[data-pairing-outcome]').text()).toContain('等它第一次连上')
  expect(pairingOutcome({ ...waiting, state: 'trust_withdrawn' })).toBe('trust_withdrawn')
})

it('reads codes in two groups and maps each ending to one message', () => {
  expect(groupedCode('042917')).toBe('042 917')
  expect(pairingOutcome({ ...waiting, state: 'paired' })).toBe('paired')
  expect(pairingOutcome({ ...waiting, state: 'expired' })).toBe('expired')
  expect(pairingOutcome({ ...waiting, state: 'cancelled', reason: 'cancelled_there' })).toBe('cancelled')
  expect(pairingOutcome({ ...waiting, state: 'failed', reason: 'coordinator_unreachable' })).toBe('failed')
  expect(pairingOutcome(waiting)).toBe(null)
})
