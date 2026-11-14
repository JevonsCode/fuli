import { describe, expect, it } from 'vitest'
import { askerLine, checkName, endingText, eventText, heldText, modesFor, shownText, visitActions, visitStateLabel, warningText } from './visit-request-model'
import { GUEST_KEY, PEER_KEY, visitRequest } from './visit-request.spec-support'

describe('a visit request in plain words', () => {
  it('offers only the actions its state allows, the main one last', () => {
    expect(visitActions({ state: 'awaiting_owner' })).toEqual(['decline', 'approve'])
    expect(visitActions({ state: 'running' })).toEqual(['cancel'])
    expect(visitActions({ state: 'awaiting_review' })).toEqual(['discard', 'keep'])
    expect(visitActions({ state: 'kept' })).toEqual([])
  })

  it('offers a guest link only 只能问', () => {
    expect(modesFor(PEER_KEY)).toEqual(['ask_only', 'plan', 'auto', 'trusted'])
    expect(modesFor(GUEST_KEY)).toEqual(['ask_only'])
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
    expect(eventText({ by: 'rule', to: 'approved', note: null })).toBe('规则：已批准')
    expect(eventText({ by: 'system', to: 'kept', note: 'cleanup_failed' })).toBe('清理副本时出了错，可能还有残留。')
    expect(eventText({ by: 'system', to: 'kept', note: 'some_new_note' })).toBe('FULI：已保留')
    expect(eventText({ by: 'system', to: 'failed', note: 'process_unconfirmed' })).toBe('这次运行的程序没确认停下，副本先留着，停下后再删。')
    expect(eventText({ by: 'system', to: 'failed', note: 'process_ended' })).toBe('运行的程序已确认停下，副本随后删掉。')
    expect(warningText('worktree_entry_kept')).toBe('副本的登记没对上，分支和登记都留着，没有删。')
    expect(warningText('some_new_warning')).toBe('清理时出了点问题，看看这件请求的经过。')
  })

  it('words every reason and code the server names, and falls back to a plain sentence for any other', () => {
    expect(endingText(visitRequest({ state: 'refused', reason: 'planning_busy' }))).toBe('助手正忙着看别的请求，没有接。')
    expect(endingText(visitRequest({ state: 'refused', reason: 'some_new_code' }))).toBe('没有接这件请求。')
    expect(endingText(visitRequest({ state: 'cancelled', reason: 'share_removed' }))).toBe('你不再共享这个项目，请求就取消了。')
    expect(endingText(visitRequest({ state: 'cancelled', reason: 'some_new_code' }))).toBe('这件请求取消了。')
    expect(endingText(visitRequest({ state: 'failed', error: 'no_constrained_client', reason: 'no_constrained_client' })))
      .toBe('这台电脑上没有能安全执行这类活的客户端（现在只用 Claude Code）。')
    expect(endingText(visitRequest({ state: 'failed', error: 'restricted_mode_unsupported' })))
      .toBe('这台电脑的 Claude Code 版本太旧，不支持受限模式，请先更新 Claude Code。')
    expect(endingText(visitRequest({ state: 'failed', error: 'some_new_code' }))).toBe('没做成。')
    expect(heldText('unsafe_content')).toBe('副本里出现了链接、嵌套仓库这类可能带来风险的内容，所以没有保存。')
    expect(heldText('too_large')).toBe('改动太大：超过 2000 个文件或 50 MB。')
    expect(heldText('runs_on_open')).toBe('改动里有打开、切换或构建分支时会自动执行的文件，先别急着打开这个分支。')
    expect(heldText('integrity_unknown')).toBe('没能在限定时间内核对你自己的文件有没有被动过，所以先扣下。')
    expect(checkName('nothing_runs_on_open')).toBe('没有会自动执行的文件')
    expect(heldText('some_new_code')).toBe('结果被拦下了，先看清楚再决定。')
    expect(checkName('content_safe')).toBe('没有会被执行的内容')
    expect(checkName('some_new_check')).toBe('其他检查：some_new_check')
  })

  it('tells a result that expired unreviewed from a request nobody decided', () => {
    const result = { summary: 'Done.', branch: 'fuli/visit/visit-1', files: [], diffstat: null }
    expect(endingText(visitRequest({ state: 'expired', result }))).toBe('14 天没看，已过期：副本删了，分支还留着。')
    expect(endingText(visitRequest({ state: 'expired' }))).toBe('7 天没人拍板，过期了。')
  })
})
