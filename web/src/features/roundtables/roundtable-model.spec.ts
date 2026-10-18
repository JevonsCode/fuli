import { describe, expect, it } from 'vitest'
import type { RoundtableMessage } from './roundtable-api'
import { splitThread, tableSeats } from './roundtable-model'

const person = (agentId: string) => ({ agentId, name: agentId.toUpperCase(), client: null })
const message = (id: string, kind: 'ask' | 'reply', from: string, to: string, extra: Partial<RoundtableMessage> = {}): RoundtableMessage => ({
  id, kind, status: kind === 'ask' ? 'queued' : 'sent', body: id, inReplyTo: null, via: null, error: null,
  createdAt: '2026-10-17T00:00:00Z', from: person(from), to: person(to), ...extra,
})

describe('roundtable model', () => {
  it('only counts an ask as conversation once a reply points at it', () => {
    const { exchanges, pending, unanswered } = splitThread([
      message('a1', 'ask', 'a', 'b', { status: 'answered' }),
      message('r1', 'reply', 'b', 'a', { inReplyTo: 'a1' }),
      message('a2', 'ask', 'a', 'c'),
      message('a3', 'ask', 'a', 'd', { status: 'expired' }),
      message('r9', 'reply', 'e', 'a', { inReplyTo: 'missing' }),
    ])
    expect(exchanges.map(item => [item.ask?.id ?? null, item.replies.map(reply => reply.id)])).toEqual([
      ['a1', ['r1']], [null, ['r9']],
    ])
    expect(pending.map(item => item.id)).toEqual(['a2'])
    expect(unanswered.map(item => item.id)).toEqual(['a3'])
  })

  it('seats everyone once and marks only those owing an open reply', () => {
    const messages = [message('a1', 'ask', 'a', 'b'), message('a2', 'ask', 'b', 'c', { status: 'failed' })]
    const { pending } = splitThread(messages)
    expect(tableSeats(messages, pending).map(seat => [seat.key, seat.spoke, seat.awaited])).toEqual([
      ['a', 1, false], ['b', 1, true], ['c', 0, false],
    ])
  })
})
