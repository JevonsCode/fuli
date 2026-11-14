import { taskAgentReceipt, withReceiptLines } from '../agents/identity-receipt.js';
import { storedHabitsLine } from '../graphiti/turn-receipt-delivery.js';

// A turn that used the roundtable says so where the reply is signed (Jevons
// 11-11): 「FULI Agents：A & B」 with a link to the conversation. A task is one
// turn, so what a turn used is kept under its task token and the next turn
// starts empty: one turn may bring in another FLA and the next may not.
//
// Kept in this process: the roundtable call and the checkpoint of a turn run
// in the same client connection. Nothing here is a record; the thread is.

const MAX_TURNS = 200;
const MAX_THREADS = 4;
const turns = new Map();

// Who took part and where it was said, for one tool result; null when the
// result names no thread.
function roundtableUse(name, result) {
  const threadId = typeof result?.threadId === 'string' ? result.threadId : null;
  if (!threadId) return null;
  // Another FLA took part once it answered, or was stood in for; a message
  // still waiting has only its conversation to show.
  const took = name === 'message_agent' ? (['answered', 'stand_in'].includes(result.status) ? result.recipient : null)
    : result.asker;
  return { threadId, peer: took?.agentId ? { agentId: took.agentId, name: took.name ?? null } : null };
}

function note(token, use) {
  const turn = turns.get(token) ?? { threads: [], peers: new Map() };
  turns.delete(token);
  turns.set(token, turn);
  if (!turn.threads.includes(use.threadId) && turn.threads.length < MAX_THREADS) turn.threads.push(use.threadId);
  if (use.peer) turn.peers.set(use.peer.agentId, use.peer);
  if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
  return turn;
}

// What the task's turn used of the roundtable so far, as a receipt takes it; null when nothing.
export function roundtableTurn(token) {
  const turn = token ? turns.get(token) : null;
  return turn ? { threads: [...turn.threads], peers: [...turn.peers.values()] } : null;
}

const RECEIPT_NOTE = 'This turn used the roundtable: end the reply with this agent_receipt.markdown, unchanged and once, '
  + 'instead of the entry one. A later roundtable or checkpoint receipt replaces it.';

// The result of message_agent or reply_agent_message, with the receipt the
// reply now ends with. A receipt that cannot be built leaves the result as it was.
export async function withRoundtableReceipt(app, name, input, result) {
  const token = input?.taskContextToken;
  const use = token ? roundtableUse(name, result) : null;
  if (!use) return result;
  note(token, use);
  try {
    const task = await app.taskContextRegistry.context(token, input.sourceApplication);
    if (!task?.projectAgentId) return result;
    const owner = await app.personal.getProjectAgent(app.config.personal.spaceId, task.personalProjectId, task.projectAgentId)
      .catch(() => null);
    const receipt = taskAgentReceipt(app, { projectId: task.personalProjectId, agentId: task.projectAgentId,
      name: owner?.profile?.display_name ?? null, role: owner?.profile?.name ?? null,
      sourceApplication: task.sourceApplication, roundtable: roundtableTurn(token) });
    // It replaces the entry receipt, so the first task of a new conversation keeps its habits line.
    const { markdown } = withReceiptLines(receipt, [storedHabitsLine(app, task)].filter(Boolean));
    return { ...result, agent_receipt: { required: true, markdown, guidance: RECEIPT_NOTE } };
  } catch {
    return result;
  }
}
