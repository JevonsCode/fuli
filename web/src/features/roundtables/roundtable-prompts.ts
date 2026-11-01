import { isBuiltInRole } from '@/features/agent-profile/fla-mention'
import type { RoundtableChatRoom, RoundtableThreadSummary } from './roundtable-api'
import { isPerson } from './roundtable-model'

const EXAMPLE_NAMES = 2

/**
 * Two FLAs the person already has at the 圆桌, for the examples of how Agents
 * start talking: the first named local FLAs of the shown conversations. Never
 * the person, another computer's Agent or a built-in role, which entry does not
 * take as a group member.
 */
export function exampleNames(threads: readonly RoundtableThreadSummary[], chats: readonly RoundtableChatRoom[]) {
  const people = [
    ...threads.flatMap(thread => thread.participants.filter(person => !isPerson(person))),
    ...chats.flatMap(room => room.members.filter(member => member.address.startsWith('local:'))),
  ]
  const names = new Set<string>()
  for (const person of people) {
    if (!person.agentId || !person.name || person.agentId.startsWith('peer:') || isBuiltInRole(person.agentId)) continue
    names.add(person.name)
    if (names.size === EXAMPLE_NAMES) break
  }
  return [...names]
}
