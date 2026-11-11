import { describe, expect, it } from 'vitest'
import type { RoundtableMessage, RoundtablePerson } from './roundtable-api'
import { chatBubbles, deliveryInFlight, postRecipients, tableSeats } from './roundtable-model'

const agent = (agentId: string): RoundtablePerson => ({ agentId, name: agentId.toUpperCase(), client: 'codex' })
const you: RoundtablePerson = { agentId: null, name: null, client: 'person' }
const message = (id: string, kind: RoundtableMessage['kind'], from: RoundtablePerson, to: RoundtablePerson, extra: Partial<RoundtableMessage> = {}): RoundtableMessage => ({
  id, kind, status: kind === 'ask' ? 'queued' : 'sent', body: id, inReplyTo: null, via: null, error: null,
  createdAt: '2026-10-17T00:00:00Z', from, to, ...extra,
})

describe('roundtable model', () => {
  it('shows a stand-in (代入) answer once: its handback to the Agent is not a second bubble or seat', () => {
    const milo = agent('milo'), jamie = agent('jamie')
    const messages = [
      message('a1', 'ask', milo, jamie, { status: 'answered', via: 'claude_code:stand_in' }),
      message('r1', 'reply', jamie, milo, { inReplyTo: 'a1', via: 'claude_code:stand_in', body: 'increment' }),
      message('h1', 'handback', milo, jamie, { inReplyTo: 'a1', via: 'claude_code:stand_in', body: 'increment' }),
    ]
    expect(chatBubbles({ messages }).map(bubble => [bubble.id, bubble.via])).toEqual([['a1', 'claude_code:stand_in'], ['r1', 'claude_code:stand_in']])
    expect(tableSeats(messages).map(seat => [seat.key, seat.spoke])).toEqual([['milo', 1], ['jamie', 1]])
  })


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

  it('seats every Agent once and marks only those owing an open reply', () => {
    const messages = [message('a1', 'ask', agent('a'), agent('b')), message('a2', 'ask', agent('b'), agent('c'), { status: 'failed' })]
    expect(tableSeats(messages).map(seat => [seat.key, seat.spoke, seat.awaited])).toEqual([
      ['a', 1, false], ['b', 1, true], ['c', 0, false],
    ])
  })

  it('seats the person once they post or are answered, counting what they said', () => {
    const named: RoundtablePerson = { agentId: null, name: 'Synthetic Person', client: 'person' }
    const messages = [message('a1', 'ask', agent('a'), agent('b'), { status: 'answered' }),
      message('p1', 'ask', you, agent('a'), { status: 'answered' }), message('r1', 'reply', agent('a'), named),
      message('p2', 'ask', named, agent('b'))]
    expect(tableSeats(messages).map(seat => [seat.key, seat.person.client, seat.spoke, seat.awaited])).toEqual([
      ['a', 'codex', 2, false], ['b', 'codex', 0, true], ['person', 'person', 2, false],
    ])
    expect(tableSeats([message('r1', 'reply', agent('a'), you)]).map(seat => seat.key)).toEqual(['a', 'person'])
  })

  it('posts to the subscribers, or in an Agents-only thread to its local FLAs', () => {
    const messages = [message('x1', 'ask', agent('peer:x'), agent('lead'))]
    expect(postRecipients({ messages })).toEqual([{ agentId: 'lead', name: 'LEAD' }])
    expect(postRecipients({ messages, subscribers: [{ agentId: 'a', name: null, delivery: 'board', instantBlocked: null }] }))
      .toEqual([{ agentId: 'a', name: 'a' }])
  })
})
