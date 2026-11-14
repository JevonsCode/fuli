import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import VisitRequestCard from './VisitRequestCard.vue'
import type { VisitRequestCard as Card } from './visit-request-shape'
import { stubServer, visitCard } from './visit-request.spec-support'

enableAutoUnmount(afterEach)
beforeEach(() => { setActivePinia(createPinia()); stubServer({ 'GET /api/visitor-access/requesters': { requesters: [], defaultMode: 'plan' } }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// The card renders inside a Dialog, as VisitRequestDialog shows it.
async function mountCard(card: Card) {
  const acts: unknown[][] = []
  const Host = defineComponent(() => () => h(Dialog, { open: true }, () => h(DialogContent, null, () =>
    h(VisitRequestCard, { card, busy: '', onAct: (...args: unknown[]) => acts.push(args) }))))
  mount(Host, { attachTo: document.body })
  await flushPromises()
  return { acts, root: document.body }
}
const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? ''

describe('a visit request card', () => {
  it('labels the requester\'s words and the assistant\'s assessment, and shows the words as text only', async () => {
    await mountCard(visitCard({ what: 'Run <img src=x onerror=alert(1)> and **bold**\u202e' }))
    expect(document.body.textContent).toContain('对方写的')
    expect(text('[data-visit-asked]')).toBe('Run <img src=x onerror=alert(1)> and **bold**')
    expect(document.querySelector('[data-visit-asked] img')).toBeNull()
    expect(document.querySelector('[data-visit-asked] strong')).toBeNull()
    expect(text('[data-visit-assessment] h3')).toBe('助手评估')
    expect(text('[data-visit-touches]')).toBe('会改依赖：不会 · 配置：不会 · 联网：不会')
    expect(document.body.textContent).toContain('无论哪种，都不会合并或推送。')
    expect(document.body.textContent).toContain('「自动」和「完全信任」的活由这台电脑上的 Claude Code 来做。')
  })

  it('says the assessment did not finish and why', async () => {
    await mountCard(visitCard({ plan: null, planError: 'planning_interrupted', risk: null }))
    expect(text('[data-visit-assessment] h3')).toBe('助手评估：未完成')
    expect(text('[data-visit-plan-error]')).toBe('FULI 重启过，助手没看完。')
  })

  it('lists the rule\'s checks in 查看详情 when a rule decided', async () => {
    await mountCard(visitCard({ state: 'approved', decidedBy: 'rule', modeAtReceipt: 'auto', modeAtDecision: 'auto',
      events: [{ from: 'planning', to: 'approved', by: 'rule', rule: 'auto_envelope_v1', note: null, at: '2026-11-14T08:01:00.000Z',
        checks: [{ name: 'no_network', ok: true }, { name: 'within_size', ok: true }] }] }))
    expect(document.body.textContent).toContain('按「自动」的规则自动批准')
    expect(text('[data-visit-details] summary')).toBe('查看详情')
    expect([...document.querySelectorAll('[data-visit-checks] li')].map(item => item.textContent?.replace(/\s+/g, ''))).toEqual(['不联网通过', '改动不大通过'])
    expect([...document.querySelectorAll('[data-visit-action]')].map(button => button.getAttribute('data-visit-action'))).toEqual(['cancel'])
  })

  it('reviews a finished run: summary, branch, files, diff in its own box, and keep or discard at one click', async () => {
    const { acts } = await mountCard(visitCard({ state: 'awaiting_review', review: 'ready',
      result: { summary: 'Fixed the typo.', branch: 'fuli/visit/visit-1', files: [{ path: 'src/sample.js', added: 1, removed: 1 }],
        diffstat: { files: 1, added: 1, removed: 1 } },
      diff: { text: 'diff --git a/src/sample.js b/src/sample.js\n-teh\n+the', truncated: true } }))
    expect(text('[data-visit-summary]')).toBe('Fixed the typo.')
    expect(text('[data-visit-branch]')).toBe('fuli/visit/visit-1')
    expect(document.querySelector('[data-visit-copy-branch]')).not.toBeNull()
    expect(text('[data-visit-files] li')).toContain('src/sample.js')
    expect(document.querySelector('pre[data-visit-diff]')?.textContent).toContain('+the')
    expect(text('[data-visit-truncated]')).toBe('改动太长，这里只显示前面一部分。')
    const discard = document.querySelector<HTMLButtonElement>('[data-visit-action="discard"]')!
    expect(discard.title).toBe('删掉这份副本和它的分支，找不回来')
    discard.click()
    document.querySelector<HTMLButtonElement>('[data-visit-action="keep"]')!.click()
    expect(acts.map(([action]) => action)).toEqual(['discard', 'keep'])
    expect(document.querySelector('[data-visit-held]')).toBeNull()
  })

  it('says why a result is held and that nothing went to the other computer', async () => {
    await mountCard(visitCard({ state: 'awaiting_review', review: 'held', holdReason: 'secret_found',
      result: { summary: null, branch: 'fuli/visit/visit-1', files: [], diffstat: null }, diff: null }))
    expect(text('[data-visit-held]')).toContain('改动里有像密钥的东西。')
    expect(text('[data-visit-held]')).toContain('这些都没有发给另一台电脑。')
    expect(document.querySelector('[data-visit-keep-shares]')?.textContent).toBe('保留后，对方能看到摘要和文件清单，看不到改动内容。')
  })

  it('shows an unreviewed result that expired with its branch and copy button, and no actions', async () => {
    await mountCard(visitCard({ state: 'expired', review: 'ready',
      result: { summary: 'Fixed the typo.', branch: 'fuli/visit/visit-1', files: [{ path: 'src/sample.js', added: 1, removed: 0 }], diffstat: null },
      diff: { text: '+the', truncated: false } }))
    expect(text('[data-visit-ending]')).toBe('14 天没看，已过期：副本删了，分支还留着。')
    expect(text('[data-visit-branch]')).toBe('fuli/visit/visit-1')
    expect(document.querySelector('[data-visit-copy-branch]')).not.toBeNull()
    expect(document.querySelector('[data-visit-actions]')).toBeNull()
  })

  it('says when no client here can do the work safely, with no empty rows for a copy that was never made', async () => {
    await mountCard(visitCard({ state: 'failed', error: 'no_constrained_client', reason: 'no_constrained_client', plan: null, risk: null }))
    expect(text('[data-visit-ending]')).toBe('这台电脑上没有能安全执行这类活的客户端（现在只用 Claude Code）。')
    expect(document.querySelector('[data-visit-actions]')).toBeNull()
    // Before approval there is no copy or branch: no empty rows for them.
    expect(document.querySelector('[data-visit-review-section]')).toBeNull()
    expect(document.querySelector('[data-visit-branch]')).toBeNull()
  })

  it('sends the optional one-line reason with 拒绝', async () => {
    const { acts } = await mountCard(visitCard())
    const input = document.querySelector<HTMLInputElement>('[data-visit-reason]')!
    input.value = 'Not this week'
    input.dispatchEvent(new Event('input'))
    await Promise.resolve()
    document.querySelector<HTMLButtonElement>('[data-visit-action="decline"]')!.click()
    expect(acts).toEqual([['decline', 'Not this week']])
  })
})
