import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StatementDetails from './StatementDetails.vue'
import type { Statement } from './statement'

const statement = (confirmed: number) => ({
  window: { from: '2026-11-09T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' },
  total: { confirmed }, series: [], carried: { tasks: 3, clients: 1, items: 5 }, unavailable: [],
}) as unknown as Statement

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const values = () => [...document.body.querySelectorAll('[data-statement-detail="totalConfirmed"] .statement-details-value')].map(item => item.textContent)

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('StatementDetails', () => {
  it('keeps the numbers on screen while the other week is read, then swaps them in place', async () => {
    let answer: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve })))
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
    wrapper.unmount()
  })
})
