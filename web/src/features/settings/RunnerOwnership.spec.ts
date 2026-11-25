import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { setLocale } from '@/i18n'
import RunnerOwnership from './RunnerOwnership.vue'

const device = { fingerprint: 'b'.repeat(64), name: 'Laptop', revokedAt: null }
const host = 'a'.repeat(64)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const project = { project: 'owned', owner: host, state: 'owned', writableHere: true, generation: 1,
  source: null, gate: { state: 'open', role: 'owner' } }
const row = { project: 'owned', moveId: 'synthetic', source: host, target: device.fingerprint,
  step: 'verified', reason: 'owner_offline', decision: 'committed' }
async function open() {
  const view = mount(RunnerOwnership, { props: { projectIds: ['owned'] } })
  const details = view.get('details')
  details.element.open = true
  await details.trigger('toggle')
  await flushPromises()
  return view
}
afterEach(() => { vi.unstubAllGlobals(); setLocale('zh-CN', { persist: false }) })

it('supports the first invitation with no selected scopes and no paired device', async () => {
  const api = vi.fn(async (path: string) => path.endsWith('/invitations') ? json({ invitation: 'synthetic' }) :
    path.endsWith('/project-ownership') ? json({ ready: false, projects: [], moves: [] }) : json({ runners: [] }))
  vi.stubGlobal('fetch', api)
  const view = await open()
  expect(view.text()).toContain('尚无已配对电脑')
  const form = view.get('form')
  await form.get('select').setValue('selected')
  await form.get('input[value="global"]').setValue(false)
  await form.trigger('submit')
  await flushPromises()
  const sent = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/runners/invitations')
  expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ name: '', scopes: [] })
  expect(view.get('textarea').element.value).toBe('synthetic')
  view.unmount()
})

it('uses the grant revision, reports offline and never offers cancellation after the owner decision', async () => {
  setLocale('en-US', { persist: false })
  let allowed = false
  const api = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/grants')) {
      const grant = { scope: 'project:owned', state: allowed ? 'allowed' : 'pending', version: 3 }
      if (options?.method === 'POST') { allowed = true; return json({ ...grant, state: 'allowed', version: 4 }) }
      return json({ pairing: 'current', scopes: [grant] })
    }
    if (path.endsWith('/project-ownership')) return json({ ready: true, device: host, projects: [
      project, { ...project, project: 'unverified', state: 'reserved' }], moves: [row] })
    return json({ runners: [device] })
  })
  vi.stubGlobal('fetch', api)
  const view = await open()
  expect(view.text()).toContain('Awaiting verification')
  expect(view.text()).toContain('Owner offline')
  expect(view.text()).not.toContain('Cancel transfer')
  await view.get('.runner-permission-row button').trigger('click')
  await flushPromises()
  const saved = api.mock.calls.find(([, options]) => options?.method === 'POST')
  expect(JSON.parse(String(saved?.[1]?.body))).toEqual({ scope: 'project:owned', state: 'allowed', version: 3, pairing: 'current' })
  expect(view.text()).toContain('Allowed')
  view.unmount()
})

it('retries an unconfirmed move using the same request ID and words', async () => {
  const api = vi.fn(async (path: string) => {
    if (path.endsWith('/project-moves')) return json({ code: 'owner_result_unknown' }, 409)
    if (path.endsWith('/project-ownership')) return json({ ready: true, device: host, projects: [project], moves: [] })
    if (path.endsWith('/grants')) return json({ pairing: 'current', scopes: [] })
    return json({ runners: [device] })
  })
  vi.stubGlobal('fetch', api)
  const view = await open()
  const form = view.findAll('form')[1]!
  await form.get('select').setValue('owned')
  await form.get('input').setValue('Transfer this project')
  await form.trigger('submit')
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toContain('送达结果待核实')
  await form.trigger('submit')
  await flushPromises()
  const calls = vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/runners/project-moves')
  expect(calls).toHaveLength(2)
  const sent = calls.map(([, options]) => JSON.parse(String(options?.body)))
  expect(sent[0]).toMatchObject({ reason: 'Transfer this project', project: 'owned', target: device.fingerprint })
  expect(sent[1]).toEqual(sent[0])
  view.unmount()
})

it('shows the effect of ending a revoked inventory before posting its pairing', async () => {
  let retired = false
  const api = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/historical-inventory')) {
      if (options?.method === 'POST') retired = true
      return json({ pairing: 'old-pair', revokedAt: 'earlier', checkedAt: null, retiredAt: retired ? 'now' : null })
    }
    if (path.endsWith('/project-ownership')) return json({ ready: true, device: host, projects: [], moves: [] })
    return json({ runners: [{ ...device, revokedAt: 'earlier' }] })
  })
  vi.stubGlobal('fetch', api)
  const view = await open()
  const button = (name: string) => view.findAll('button').find(b => b.text() === name)!
  await button('查看盘点状态').trigger('click')
  await flushPromises()
  expect(view.text()).toContain('不能重新配对')
  expect(retired).toBe(false)
  await button('结束旧设备盘点').trigger('click')
  await flushPromises()
  expect(JSON.parse(String(api.mock.calls.find(([, o]) => o?.method === 'POST')?.[1]?.body))).toEqual({ pairing: 'old-pair' })
  view.unmount()
})
