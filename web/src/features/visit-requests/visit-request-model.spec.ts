import { describe, expect, it } from 'vitest'
import { askerLine, endingText, eventText, modesFor, shownText, visitActions, visitStateLabel } from './visit-request-model'
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
})
