import { describe, expect, it } from 'vitest'
import { askerLine, checkName, endingText, eventText, heldText, modesFor, shownText, visitActions, visitStateLabel } from './visit-request-model'
import { GUEST_KEY, PEER_KEY, visitRequest } from './visit-request.spec-support'

describe('a visit request in plain words', () => {
  it('offers only the actions its state allows, the main one last', () => {
    expect(visitActions({ state: 'awaiting_owner' })).toEqual(['decline', 'approve'])
    expect(visitActions({ state: 'running' })).toEqual(['cancel'])
    expect(visitActions({ state: 'awaiting_review' })).toEqual(['discard', 'keep'])
    expect(visitActions({ state: 'kept' })).toEqual([])
  })

  it('never offers 自动 or 完全信任 to a guest link', () => {
    expect(modesFor(PEER_KEY)).toEqual(['ask_only', 'plan', 'auto', 'trusted'])
    expect(modesFor(GUEST_KEY)).toEqual(['ask_only', 'plan'])
  })

  it('names the computer and its assistant, and a finished run by whether it is ready', () => {
    expect(askerLine(visitRequest().requester)).toBe('Synthetic laptop 的 Sample lead')
    expect(askerLine({ ...visitRequest().requester, agentName: null })).toBe('Synthetic laptop')
    expect(visitStateLabel({ state: 'unknown', review: null })).toBe('不确定有没有做完')
    expect(visitStateLabel({ state: 'awaiting_review', review: 'held' })).toBe('需要你看一下')
  })

  it('drops control, zero-width and bidirectional characters but keeps line breaks', () => {
    expect(shownText('fix\u0007 the\u200b typo\u202e\nnext line')).toBe('fix the typo\nnext line')
  })

  it('says how a request ended and who moved it', () => {
    expect(endingText(visitRequest({ state: 'refused', reason: 'budget_exceeded' }))).toBe('对方今天请得太多了。')
    expect(endingText(visitRequest({ state: 'declined', reason: 'Not this week' }))).toBe('你写的理由：Not this week')
    expect(endingText(visitRequest({ state: 'awaiting_owner' }))).toBeNull()
    expect(eventText({ by: 'rule', to: 'approved' })).toBe('规则：已批准')
  })

  it('words every reason and code the server names, and falls back to a plain sentence for any other', () => {
    expect(endingText(visitRequest({ state: 'refused', reason: 'planning_busy' }))).toBe('助手正忙着看别的请求，没有接。')
    expect(endingText(visitRequest({ state: 'refused', reason: 'some_new_code' }))).toBe('没有接这件请求。')
    expect(endingText(visitRequest({ state: 'cancelled', reason: 'share_removed' }))).toBe('你不再共享这个项目，请求就取消了。')
    expect(endingText(visitRequest({ state: 'cancelled', reason: 'some_new_code' }))).toBe('这件请求取消了。')
    expect(endingText(visitRequest({ state: 'failed', error: 'fuli_mcp_unavailable' }))).toBe('助手连不上 FULI，没做成。')
    expect(endingText(visitRequest({ state: 'failed', error: 'some_new_code' }))).toBe('没做成。')
    expect(heldText('unsafe_content')).toContain('嵌套的仓库')
    expect(heldText('too_large')).toBe('改动太大：超过 2000 个文件或 50 MB。')
    expect(heldText('some_new_code')).toBe('结果被拦下了，先看清楚再决定。')
    expect(checkName('constrained_client')).toBe('助手在受限的客户端里做')
    expect(checkName('some_new_check')).toBe('其他检查：some_new_check')
  })

  it('tells a result that expired unreviewed from a request nobody decided', () => {
    const result = { summary: 'Done.', branch: 'fuli/visit/visit-1', files: [], diffstat: null }
    expect(endingText(visitRequest({ state: 'expired', result }))).toBe('14 天没看，已过期：副本删了，分支还留着。')
    expect(endingText(visitRequest({ state: 'expired' }))).toBe('7 天没人拍板，过期了。')
  })
})
