import { describe, expect, it } from 'vitest'
import type { RoundtableChatRoom, RoundtableThreadSummary } from './roundtable-api'
import { exampleNames } from './roundtable-prompts'

type Person = { agentId: string | null; name: string | null; client?: string }
const summary = (people: Person[]) => ({ id: 't', subject: 's', updatedAt: '2026-10-10T08:00:00Z', waiting: false,
  participants: people.map(person => ({ client: 'codex', ...person })) }) as RoundtableThreadSummary
const room = (members: { address: string; agentId: string | null; name: string | null }[]) =>
  ({ chatId: 'c', kind: 'group', title: null, members: members.map(member => ({ ...member, joinedSeq: 0 })), createdAt: '', updatedAt: '' }) as unknown as RoundtableChatRoom

describe('exampleNames', () => {
  it('takes the first two named local FLAs, once each', () => {
    expect(exampleNames([summary([{ agentId: 'a', name: 'Ada' }, { agentId: 'a', name: 'Ada' }])],
      [room([{ address: 'local:b', agentId: 'b', name: 'Bo' }, { address: 'local:c', agentId: 'c', name: 'Cy' }])])).toEqual(['Ada', 'Bo'])
  })

  it('skips the person, unnamed Agents, built-in roles, another computer\'s Agents and remote room members', () => {
    expect(exampleNames([summary([{ agentId: 'me', name: 'You', client: 'person' }, { agentId: 'x', name: null },
      { agentId: 'employee.jefa', name: 'Jefa' }, { agentId: 'peer:r', name: 'Remote' }])],
      [room([{ address: 'peer:n/d', agentId: 'd', name: 'Far' }, { address: 'local:e', agentId: 'e', name: 'Eve' }])])).toEqual(['Eve'])
  })
})
