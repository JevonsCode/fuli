import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import TodayStatement from './TodayStatement.vue'
import { statementTiles, type Statement } from './statement'

// The statement's tiles that open the rows they count. Synthetic conversations and items only.
const WEEK = { from: '2026-11-08T16:00:00.000Z', to: '2026-11-15T16:00:00.000Z' }
const statement = { window: WEEK, carried: { tasks: 3, clients: 2, items: 9 }, used: { times: 4, tasks: 2, cited: 1, applied: 3 },
  learned: { captured: 2, confirmedByYou: 5, confirmedByTonborg: 0, promotedByUse: 0, retired: 0 }, unavailable: [] } as unknown as Statement
const item = (id: string) => ({ item_kind: 'entity', item_id: id, version: 1, title: `Item ${id}`, content: `Synthetic item ${id}`,
  type: 'Preference', category: 'rule', scope: { kind: 'global', projects: [], status: 'set' }, weight: null, tags: [],
  confirmation_status: 'confirmed', content_source: 'user_explicit', evidence: [], evidence_count: 0, revisions: [] })
const carried = { more: true, rows: [
  { key: 'aaaaaaaaaaaaaaaa', at: '2026-11-16T04:00:00.000Z', client: 'claude_code', model: 'synthetic-model', habits: 16, recalled: 3 },
  { key: 'bbbbbbbbbbbbbbbb', at: '2026-11-16T03:00:00.000Z', client: 'codex', model: null, habits: 0, recalled: 2 },
  { key: null, at: '2026-11-16T02:00:00.000Z', client: null, model: null, habits: 0, recalled: 1 },
] }
const learned = { captured: { total: 2, items: [{ kind: 'entity', id: 'new-1', at: '2026-11-16T04:00:00.000Z' }, { kind: 'entity', id: 'new-gone', at: '2026-11-16T03:00:00.000Z' }] },
  confirmedByYou: { total: 5, items: [{ kind: 'entity', id: 'kept-1', at: '2026-11-16T04:00:00.000Z' }] } }

async function mounted(answer: (url: string) => unknown) {
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => answer(url))
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { template: '<div />' } }] })
  const wrapper = mount(TodayStatement, { props: { statement, total: 42, tiles: statementTiles(statement) },
    global: { plugins: [pinia, router] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const answers = (url: string) => {
  if (url.startsWith('/api/statement/carried')) return carried
  if (url.startsWith('/api/statement/learned')) return learned
  const id = decodeURIComponent(url.split('/api/knowledge/entity/')[1]?.split('?')[0] ?? '')
  if (id.endsWith('gone')) throw new ApiError('gone', 404)
  return item(id)
}
const urls = () => getJson.mock.calls.map(call => String(call[0]).split('?')[0])
const dialogText = (selector: string) => [...document.body.querySelectorAll(selector)].map(row => row.textContent?.replace(/\s+/g, ' ').trim())

afterEach(() => { document.body.innerHTML = '' })

describe('statement tiles that open their rows', () => {
  it('only the tiles with a list are buttons; the others stay plain numbers', async () => {
    const wrapper = await mounted(answers)
    expect(wrapper.findAll('[data-statement-tile]').map(tile => [tile.attributes('data-statement-tile'), tile.element.tagName])).toEqual([
      ['carried', 'BUTTON'], ['used', 'DIV'], ['learned', 'BUTTON']])
    expect(getJson).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('lists the conversations that carried habits; one that was handed habits opens its habit list', async () => {
    const wrapper = await mounted(answers)
    await wrapper.get('[data-statement-tile="carried"]').trigger('click')
    await flushPromises()
    // The rows are read for the week the tile's number was read for, not for the week it is now.
    expect(String(getJson.mock.calls[0]?.[0])).toBe(`/api/statement/carried?${new URLSearchParams(WEEK)}`)
    expect(document.body.querySelector('dialog h2')?.textContent).toBe('带上习惯的对话')
    const rows = [...document.body.querySelectorAll('[data-statement-carried]')]
    expect(rows.map(row => row.querySelector('a')?.getAttribute('href') ?? null)).toEqual(['/habits/aaaaaaaaaaaaaaaa', null, null])
    expect(rows.map(row => row.querySelector('.statement-list-meta')?.textContent)).toEqual([
      '带上 16 条习惯 · 想起 3 条经验 · synthetic-model', '想起 2 条经验', '想起 1 条经验'])
    expect(rows.map(row => row.querySelector('.statement-list-main')?.textContent?.split(' · ')[0])).toEqual(['Claude Code', 'Codex', '客户端没记下'])
    expect(document.body.querySelector('[data-statement-list-more]')?.textContent).toBe('只列出最近 3 次。')
    wrapper.unmount()
  })

  it('lists what was learned and what was confirmed, reading a tab when it is first shown', async () => {
    const wrapper = await mounted(answers)
    await wrapper.get('[data-statement-tile="learned"]').trigger('click')
    await flushPromises()
    expect(dialogText('dialog .ui-segmented button')).toEqual(['新学到的2', '你确认的5'])
    expect(dialogText('[data-statement-learned]')).toEqual(['Synthetic item new-1个人全局', '这条后来删掉了'])
    expect(document.body.querySelector('[data-statement-learned="new-1"] a')?.getAttribute('href')).toBe('/knowledge/item/space/entity/new-1')
    expect(document.body.querySelector('[data-statement-list-more]')).toBeNull()
    expect(urls()).toEqual(['/api/statement/learned', '/api/knowledge/entity/new-1', '/api/knowledge/entity/new-gone'])

    const tabs = [...document.body.querySelectorAll<HTMLElement>('dialog .ui-segmented button')]
    tabs[1]!.click()
    await flushPromises()
    expect(dialogText('[data-statement-learned]')).toEqual(['Synthetic item kept-1个人全局'])
    expect(document.body.querySelector('[data-statement-list-more]')?.textContent).toBe('共 5 条，这里列出最近 1 条。')
    tabs[0]!.click()
    await flushPromises()
    expect(dialogText('[data-statement-learned]')).toHaveLength(2)
    expect(urls().filter(url => url.endsWith('/new-1'))).toHaveLength(1)
    wrapper.unmount()
  })

  it('重试 after a tab could not be read reads that tab again and stays on it', async () => {
    let fail = false
    const wrapper = await mounted((url) => { if (fail && url.includes('/kept-1')) throw new ApiError('synthetic failure', 500); return answers(url) })
    await wrapper.get('[data-statement-tile="learned"]').trigger('click')
    await flushPromises()
    fail = true
    document.body.querySelectorAll<HTMLElement>('dialog .ui-segmented button')[1]!.click()
    await flushPromises()
    expect(document.body.querySelector('dialog [role="alert"]')?.textContent).toContain('synthetic failure')
    fail = false
    document.body.querySelector<HTMLElement>('dialog [role="alert"] button')!.click()
    await flushPromises()
    expect(dialogText('dialog .ui-segmented button[aria-pressed="true"]')).toEqual(['你确认的5'])
    expect(dialogText('[data-statement-learned]')).toEqual(['Synthetic item kept-1个人全局'])
    expect(urls().filter(url => url === '/api/statement/learned')).toHaveLength(1)
    wrapper.unmount()
  })

  it('says a list cannot be read and reads it again on 重试', async () => {
    let fail = true
    const wrapper = await mounted((url) => { if (fail) throw new ApiError('synthetic failure', 500); return answers(url) })
    await wrapper.get('[data-statement-tile="carried"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('dialog [role="alert"]')?.textContent).toContain('读不到这份明细：synthetic failure')
    fail = false
    document.body.querySelector<HTMLElement>('dialog [role="alert"] button')!.click()
    await flushPromises()
    expect(document.body.querySelectorAll('[data-statement-carried]')).toHaveLength(3)
    wrapper.unmount()
  })
})
