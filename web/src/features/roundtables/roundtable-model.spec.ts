import { describe, expect, it } from 'vitest'
import type { RoundtableMessage, RoundtablePerson } from './roundtable-api'
import { chatBubbles, deliveryInFlight, postRecipients, tableSeats } from './roundtable-model'

const agent = (agentId: string): RoundtablePerson => ({ agentId, name: agentId.toUpperCase(), client: 'codex' })
const you: RoundtablePerson = { agentId: null, name: null, client: 'person' }
const message = (id: string, kind: 'ask' | 'reply', from: RoundtablePerson, to: RoundtablePerson, extra: Partial<RoundtableMessage> = {}): RoundtableMessage => ({
  id, kind, status: kind === 'ask' ? 'queued' : 'sent', body: id, inReplyTo: null, via: null, error: null,
  createdAt: '2026-10-17T00:00:00Z', from, to, ...extra,
})

describe('roundtable model', () => {
  it('shows a group post as one bubble with each recipient\'s own recorded state', () => {
    const bubbles = chatBubbles({ subscribers: [
      { agentId: 'a', name: 'A', delivery: 'instant', instantBlocked: null },
      { agentId: 'b', name: 'B', delivery: 'instant', instantBlocked: 'no_client' },
    ], messages: [
      message('p1', 'ask', you, agent('a'), { body: 'Hello both', status: 'delivering' }),
      message('p2', 'ask', you, agent('b'), { body: 'Hello both', error: 'no_client' }),
      message('r1', 'reply', agent('a'), you, { inReplyTo: 'p1' }),
      message('p3', 'ask', you, agent('a'), { body: 'Next' }),
    ] })
    expect(bubbles.map(bubble => [bubble.id, bubble.mine, bubble.deliveries.map(item => [item.to.agentId, item.state])])).toEqual([
      ['p1', true, [['a', { kind: 'replying' }], ['b', { kind: 'held', reason: 'no_client' }]]],
      ['r1', false, []],
      ['p3', true, [['a', { kind: 'waking' }]]],
    ])
    expect(deliveryInFlight(bubbles)).toBe(true)
  })

  it('keeps board, failed and remote states as recorded and is idle when nothing runs', () => {
    const bubbles = chatBubbles({ subscribers: [{ agentId: 'a', name: 'A', delivery: 'board', instantBlocked: null }], messages: [
      message('p1', 'ask', you, agent('a')),
      message('x1', 'ask', agent('peer:x'), agent('a'), { status: 'failed', error: 'lead_changed' }),
      message('x2', 'ask', agent('a'), agent('peer:y'), { status: 'sent', via: 'peer' }),
    ] })
    expect(bubbles.map(bubble => bubble.deliveries[0]!.state)).toEqual([
      { kind: 'board' }, { kind: 'failed', reason: 'lead_changed' }, { kind: 'status', status: 'sent' },
    ])
    expect(deliveryInFlight(bubbles)).toBe(false)
  })

  it('seats every Agent once, never the person, and marks only those owing an open reply', () => {
    const messages = [message('a1', 'ask', agent('a'), agent('b')), message('a2', 'ask', agent('b'), agent('c'), { status: 'failed' }),
      message('p1', 'ask', you, agent('a'), { status: 'answered' })]
    expect(tableSeats(messages).map(seat => [seat.key, seat.spoke, seat.awaited])).toEqual([
      ['a', 1, false], ['b', 1, true], ['c', 0, false],
    ])
  })

  it('posts to the subscribers, or in an Agents-only thread to its local FLAs', () => {
    const messages = [message('x1', 'ask', agent('peer:x'), agent('lead'))]
    expect(postRecipients({ messages })).toEqual([{ agentId: 'lead', name: 'LEAD' }])
    expect(postRecipients({ messages, subscribers: [{ agentId: 'a', name: null, delivery: 'board', instantBlocked: null }] }))
      .toEqual([{ agentId: 'a', name: 'a' }])
  })
})
