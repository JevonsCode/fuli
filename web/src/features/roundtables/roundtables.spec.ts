import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setLocale } from '@/i18n'
import RoundtablesPage from './RoundtablesPage.vue'
import RoundtableCreate from './RoundtableCreate.vue'
import RoundtableSeats from './RoundtableSeats.vue'
import RoundtableDetail from './RoundtableDetail.vue'
import RoundtableResults from './RoundtableResults.vue'
import RoundtableEvents from './RoundtableEvents.vue'
import type { RoundtableSnapshot } from './roundtable-api'
const { api } = vi.hoisted(() => ({ api: { list: vi.fn(), read: vi.fn(), create: vi.fn(), control: vi.fn(), message: vi.fn(), invite: vi.fn(), revoke: vi.fn() } }))
vi.mock('./roundtable-api', () => ({ roundtableApi: api }))
const wrappers: ReturnType<typeof mount>[] = []
function fixture(): RoundtableSnapshot {
  return { room: { id: 'room-1', goal: 'Review the migration', mode: 'discussion', status: 'active', phase: 'discussion', revision: 7,
    limits: { maxRounds: 3, maxMessages: 30, maxDurationMs: 1800000, turnTimeoutMs: 300000 }, createdAt: '2026-10-09T01:00:00Z',
    seats: [{ id: 'a', name: 'Alice', role: 'moderator', runtime: 'codex', joinedAt: '2026-10-09T01:00:00Z' }, { id: 'b', name: 'Bob', role: 'reviewer', runtime: 'claude-code' }] },
    messages: [{ id: 'm1', seq: 1, seatId: 'a', kind: 'proposal', body: 'Keep backups first', createdAt: '2026-10-09T01:01:00Z', actual: null }],
    currentTurn: { id: 'turn-2', seatId: 'b', status: 'pending', phase: 'discussion' }, tasks: [], outcome: null }
}
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); api.control.mockResolvedValue({}); api.message.mockResolvedValue({}); setLocale('zh-CN', { persist: false }) })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.restoreAllMocks() })
describe('Roundtable UI', () => {
  it('keeps loaded history and unsent user text after a failed refresh', async () => {
    api.read.mockResolvedValueOnce(fixture()).mockRejectedValueOnce(new Error('Coordinator offline'))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/roundtables/:roomId', component: RoundtablesPage }] })
    await router.push('/roundtables/room-1')
    const wrapper = mount(RoundtablesPage, { global: { plugins: [router] } }); wrappers.push(wrapper); await flushPromises()
    await wrapper.get('textarea').setValue('Preserve my draft')
    await wrapper.findAll('button').find(button => button.text() === '刷新')!.trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('Coordinator offline')
    expect(wrapper.text()).toContain('Keep backups first')
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Preserve my draft')
    expect(wrapper.find('[data-testid="runtime-receipts"]').exists()).toBe(false)
  })
  it('uses only actual source evidence and shows unknown usage rather than configured adapters', () => {
    const snapshot = fixture()
    let wrapper = mount(RoundtableResults, { props: { snapshot } }); wrappers.push(wrapper)
    expect(wrapper.find('[data-testid="no-runtime-receipts"]').exists()).toBe(true)
    snapshot.messages.push({ id: 'm2', seq: 2, seatId: 'b', kind: 'dissent', body: 'Rollback still missing', createdAt: '2026-10-09T01:02:00Z', actual: { sourceApplication: 'actual-host', model: 'reported-model', sessionId: 'session-real', usage: null } })
    wrapper = mount(RoundtableResults, { props: { snapshot } }); wrappers.push(wrapper)
    const table = wrapper.get('[data-testid="runtime-receipts"]')
    expect(table.text()).toContain('actual-host'); expect(table.text()).toContain('reported-model'); expect(table.text()).toContain('未知')
    expect(table.text()).not.toContain('claude-code'); expect(table.findAll('tbody tr')).toHaveLength(1)
    expect(wrapper.text()).toContain('Rollback still missing')
  })
  it('keeps invite credentials out of storage and command arguments, then removes the view on hide', async () => {
    api.invite.mockResolvedValue({ roomId: 'room-1', seatId: 'a', seatToken: 'test-seat-secret', expiresAt: '2026-10-09T03:00:00Z' })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mount(RoundtableSeats, { props: { room: fixture().room } }); wrappers.push(wrapper)
    await wrapper.findAll('button').find(button => button.text() === '邀请参与')!.trigger('click'); await flushPromises()
    expect((wrapper.get('[data-testid="seat-token"]').element as HTMLInputElement).value).toBe('test-seat-secret')
    expect(wrapper.get('pre').text()).not.toContain('test-seat-secret')
    expect(wrapper.get('pre').text()).toContain('FULI_ROUNDTABLE_TOKEN')
    expect(window.localStorage.length).toBe(0)
    await wrapper.findAll('button').find(button => button.text() === '复制凭据')!.trigger('click'); await flushPromises()
    expect(writeText).toHaveBeenCalledWith('test-seat-secret')
    await wrapper.findAll('button').find(button => button.text() === '隐藏凭据')!.trigger('click')
    expect(wrapper.find('[data-testid="seat-token"]').exists()).toBe(false)
  })
  it('keeps creation draft on failure and requires collaboration roles', async () => {
    api.create.mockRejectedValue(new Error('Project binding unavailable'))
    const wrapper = mount(RoundtableCreate); wrappers.push(wrapper)
    await wrapper.get('textarea').setValue('My shared objective')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ goal: 'My shared objective', mode: 'discussion' }))
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('My shared objective')
    expect(wrapper.text()).toContain('Project binding unavailable')
    await wrapper.findAll('select')[0]!.setValue('collaboration')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  })
  it('generates a Pi worker command with the participant local model and literal quoting', async () => {
    const room = fixture().room; room.seats[0]!.runtime = 'pi'
    api.invite.mockResolvedValue({ roomId: room.id, seatId: 'a', seatToken: 'private-pi-seat', expiresAt: '2026-10-09T03:00:00Z' })
    const wrapper = mount(RoundtableSeats, { props: { room } }); wrappers.push(wrapper)
    await wrapper.findAll('button').find(button => button.text() === '邀请参与')!.trigger('click'); await flushPromises()
    await wrapper.get('input[placeholder="fuli-roundtable-qwen3-32k:latest"]').setValue("local'model")
    expect(wrapper.get('pre').text()).toContain("--runtime pi")
    expect(wrapper.get('pre').text()).toContain("--model 'local''model'")
    expect(wrapper.get('pre').text()).not.toContain('private-pi-seat')
  })
  it('sends the observed revision for controls and preserves the requirement when sending fails', async () => {
    api.message.mockRejectedValue(new Error('Room paused remotely'))
    const wrapper = mount(RoundtableDetail, { props: { snapshot: fixture(), refreshing: false } }); wrappers.push(wrapper)
    await wrapper.findAll('button').find(button => button.text() === '暂停')!.trigger('click'); await flushPromises()
    expect(api.control).toHaveBeenCalledExactlyOnceWith('room-1', 'pause', 7, '')
    await wrapper.get('textarea').setValue('Require integration evidence')
    await wrapper.get('.rt-input-form').trigger('submit'); await flushPromises()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Require integration evidence')
    expect(wrapper.text()).toContain('Room paused remotely')
  })
  it('does not render human acceptance before an actual synthesis outcome', async () => {
    const snapshot = fixture(); snapshot.room.status = 'waiting_input'; snapshot.room.phase = 'synthesis'
    const wrapper = mount(RoundtableDetail, { props: { snapshot, refreshing: false } }); wrappers.push(wrapper)
    expect(wrapper.text()).not.toContain('确认接受交付')
    await wrapper.setProps({ snapshot: { ...snapshot, outcome: { body: 'Reported conclusion', acceptance: 'pending', createdAt: '2026-10-09T02:00:00Z' } } })
    await wrapper.findAll('button').find(button => button.text() === '检查并接受交付')!.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '确认接受交付')!.trigger('click'); await flushPromises()
    expect(api.control).toHaveBeenCalledWith('room-1', 'complete', 7, '')
  })
  it('discards a late response when navigating to another room', async () => {
    let resolveFirst!: (value: RoundtableSnapshot) => void
    api.read.mockReturnValueOnce(new Promise<RoundtableSnapshot>(resolve => { resolveFirst = resolve }))
    const second = fixture(); second.room.id = 'room-2'; second.room.goal = 'Second room objective'; second.messages = []
    api.read.mockResolvedValueOnce(second)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/roundtables/:roomId', component: RoundtablesPage }] })
    await router.push('/roundtables/room-1')
    const wrapper = mount(RoundtablesPage, { global: { plugins: [router] } }); wrappers.push(wrapper)
    await router.push('/roundtables/room-2'); await flushPromises()
    resolveFirst(fixture()); await flushPromises()
    expect(wrapper.text()).toContain('Second room objective')
    expect(wrapper.text()).not.toContain('Review the migration')
    expect(wrapper.text()).not.toContain('Keep backups first')
  })
  it('separates claimed leases, unconfirmed cancellations and stale results from execution receipts', () => {
    const snapshot = fixture()
    snapshot.attempts = [{ id: 'attempt-1', turnId: 'turn-1', seatId: 'a', status: 'running', startedAt: 1791507900000 }]
    snapshot.events = [{ id: 'event-1', kind: 'cancellation_requested', createdAt: 1791507960000, confirmed: false }]
    snapshot.lateResults = [{ turnId: 'turn-old', attemptId: 'old-attempt', seatId: 'a', receivedAt: 1791508020000, body: 'Stale output stays archived', status: 'stale' }]
    const wrapper = mount(RoundtableEvents, { props: { snapshot } }); wrappers.push(wrapper)
    expect(wrapper.text()).toContain('领取本身不证明已调用模型')
    expect(wrapper.text()).toContain('取消尚未确认')
    expect(wrapper.text()).toContain('Stale output stays archived')
    expect(wrapper.find('[data-testid="runtime-receipts"]').exists()).toBe(false)
  })
  it('changes limits only on explicit submission and preserves a draft across identical polling snapshots', async () => {
    const snapshot = fixture(); snapshot.room.status = 'paused'
    const wrapper = mount(RoundtableDetail, { props: { snapshot, refreshing: false } }); wrappers.push(wrapper)
    await wrapper.findAll('.rt-budget-form input')[1]!.setValue('20')
    await wrapper.setProps({ snapshot: structuredClone(snapshot) })
    expect((wrapper.findAll('.rt-budget-form input')[1]!.element as HTMLInputElement).value).toBe('20')
    expect(api.control).not.toHaveBeenCalled()
    await wrapper.get('.rt-budget-form').trigger('submit'); await flushPromises()
    expect(api.control).toHaveBeenCalledExactlyOnceWith('room-1', 'update_limits', 7, '', { maxRounds: 3, maxMessages: 20, maxDurationMs: 1800000, turnTimeoutMs: 300000 })
  })
})
