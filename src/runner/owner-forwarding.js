import { answerCode } from './local-answer-note.js';
import { failure, withoutOfflineToken, withRunnerNote } from './offline-calls.js';

// A change a follower's own half could not make because the record it names
// is this computer's read-only copy of the host's global
// (docs/runner-roles-design.md §12): the Provider refused it (409
// replica_read_only) and wrote nothing. For the tools below the same call is
// handed to the host once, without this computer's task token, and answered as
// the host answers it. The host away: said as it is, and nothing is queued, so
// no change made offline meets another made there meanwhile. Any other tool
// keeps the refusal. One tool a line, with why the host may simply take it.
export const FORWARDED_TO_OWNER = Object.freeze({
  // One kept item by its id: a habit of global is the host's record.
  revise_personal_knowledge: 'changes one kept item by its id, as the host would',
  // The person's word on one item: its confirmation lives on the item.
  record_knowledge_feedback: 'the person\'s feedback on one item, kept on that item',
  // The tags of one item, and the person's own tags and their aliases.
  change_knowledge_tags: 'tags of one item and the person\'s own tag names, which global owns',
  // An FLA's name is the roster's, which global owns.
  rename_project_agent: 'one FLA\'s name, which is the roster\'s'
});

export function refusedAsCopy(answer) {
  return answerCode(answer) === 'replica_read_only';
}

// tool, name, args: the call as the client made it (name, args through fuli_call).
// sendToHost(name, args): the host's answer, or null while it is away.
export async function forwardToOwner({ tool, name, args, sendToHost, hostName }) {
  const answer = await sendToHost(name, withoutOfflineToken(name, args));
  if (!answer) {
    return failure('owner_unreachable', `This is ${hostName}'s (a record of global, read here as a copy), and ${hostName} `
      + 'is away, so nothing was changed. Make the change again once the two computers are connected.\n'
      + `这是 ${hostName} 的内容（全局记录，这里只是副本）；${hostName} 不在线，没改。两台电脑连上后再改一次。`, { tool });
  }
  return withRunnerNote(answer, { answeredBy: 'host', host: hostName,
    message: `This is ${hostName}'s (a record of global); it was handed to ${hostName}, which answered.\n`
      + `这是 ${hostName} 的内容（全局记录），已交给 ${hostName}。` });
}
