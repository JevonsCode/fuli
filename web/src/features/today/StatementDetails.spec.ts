import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StatementDetails from './StatementDetails.vue'
import type { Statement } from './statement'

const statement = (confirmed: number) => ({
  window: { from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' },
  total: { confirmed }, series: [], carried: { tasks: 3, clients: 1, items: 5 }, unavailable: [],
}) as unknown as Statement

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const values = () => [...document.body.querySelectorAll('[data-statement-detail="totalConfirmed"] .statement-rows-value')].map(item => item.textContent)
const usage = (rows: unknown[]) => ({ window: {}, rows, more: false, unavailable: [] })
const usageRows = () => [...document.body.querySelectorAll('[data-statement-usage] li')]
  .map(item => [...item.children].map(part => part.textContent?.trim()).join(' '))

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('StatementDetails', () => {
  it('keeps the numbers on screen while the other week is read, then swaps them in place', async () => {
    let answer: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((url: string) => String(url).includes('/api/statement/usage')
      ? Promise.resolve(json(usage([])))
      : new Promise<Response>(resolve => { answer = resolve })))
    const wrapper = mount(StatementDetails, { props: { open: true, statement: statement(42) }, attachTo: document.body })
    await flushPromises()
    expect(values()).toEqual(['42'])

    const previous = [...document.body.querySelectorAll('button, [role="radio"], [role="tab"]')].find(item => item.textContent?.trim() === '上一周') as HTMLElement
    previous.click()
    await flushPromises()
    // Still reading: the list is there with the week being left, marked busy; nothing was replaced by a loading block.
    expect(values()).toEqual(['42'])
    expect(document.body.querySelector('[data-statement-rows]')?.getAttribute('aria-busy')).toBe('true')
    expect(document.body.querySelector('.statement-details-reading [role="status"]')).not.toBeNull()

    answer(json(statement(30)))
    await flushPromises()
    expect(values()).toEqual(['30'])
    expect(document.body.querySelector('[data-statement-rows]')?.getAttribute('aria-busy')).toBe('false')
    expect(document.body.querySelector('.statement-details-reading [role="status"]')).toBeNull()
    // No client or model to show says nothing.
    expect(document.body.querySelector('[data-statement-usage]')).toBeNull()
    wrapper.unmount()
  })

  it('lists each client and model with its counts; a model nobody reported reads unknown, tokens only as reported', async () => {
    const fetch = vi.fn((_url: string) => Promise.resolve(json(usage([
      { client: 'codex', model: 'synthetic-model-a', taskEntries: 3, wakes: 0, tokens: null },
      { client: 'claude_code', model: null, taskEntries: 1, wakes: 2, tokens: { input: 300, output: 20, answers: 1 } },
      { client: 'claude_code', model: 'synthetic-model-b', taskEntries: 0, wakes: 1, tokens: { input: null, output: 5, answers: 1 } },
    ]))))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(StatementDetails, { props: { open: true, statement: statement(42) }, attachTo: document.body })
    await flushPromises()
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^\/api\/statement\/usage\?from=.+&to=.+/)
    expect(document.body.querySelector('[data-statement-usage] h3')?.textContent).toBe('用了哪些客户端和模型')
    expect(usageRows()).toEqual([
      'Cx Codex · synthetic-model-a 3 次对话 FULI 亲眼看到的',
      'CC Claude Code · 模型未知 1 次对话 · 叫醒 2 次 · 320 Token FULI 亲眼看到的；Token 是客户端在 1 次回答里自己报告的',
      // Only an output count was reported: no total is shown rather than a partial one.
      'CC Claude Code · synthetic-model-b 叫醒 1 次 FULI 亲眼看到的',
    ])
    expect(document.body.querySelector('[data-statement-usage-row="codex"] [role="img"]')?.getAttribute('aria-label')).toBe('Codex')
    wrapper.unmount()
  })
})
