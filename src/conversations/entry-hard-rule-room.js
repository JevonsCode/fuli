// Room for hard rules: where an entry's hard rules do not all fit its host's
// inline limit even with every detail reduced to a pointer
// (entry-inline-budget.js), the pointers give way further, down to what a
// later call needs. Each keeps its read, which returns what is left out (and
// the rules by their fuli://rules section). An entry whose hard rules fit
// never gets this far.
import { managerRead, memoryRead } from './entry-detail-readers.js';

export const withContinuity = (value, field, view) => ({ ...value,
  project_agent_context: { ...value.project_agent_context, [field]: view } });
export const present = values => Object.fromEntries(Object.entries(values).filter(([, item]) => item !== undefined));

// Steps in the shape of the fit's detail steps: each returns the entry with
// one detail reduced, or null when there is nothing to reduce. Each makes its
// pointer from the detail as it is, reduced or not, so any subset applies on
// its own.
export const HARD_RULE_ROOM_STEPS = Object.freeze([
  value => value.project_agent_context?.global_memory ? withContinuity(value, 'global_memory',
    leanMemoryPointer(value.project_agent_context.global_memory, memoryRead(value, null))) : null,
  value => value.project_agent_context?.memory ? withContinuity(value, 'memory',
    leanMemoryPointer(value.project_agent_context.memory, memoryRead(value, value.context?.personal_project_id ?? null))) : null,
  // The recall's pointer (the fit made it one before any detail): its count and search.
  value => {
    const recall = value.task_knowledge_recall;
    if (!recall?.read) return null;
    return { ...value, task_knowledge_recall: present({ status: recall.status, items_omitted: recall.items_omitted,
      read: recall.read }) };
  },
  // The recent conversation once its messages have given way: its ID,
  // revision and the call that resumes it. Messages still to be sent never
  // give way here.
  value => {
    const conversation = value.conversation;
    if (!conversation?.conversation_id || !conversation.recovery || conversation.recovery.messages?.length
      || typeof value.taskContextToken !== 'string') return null;
    return { ...value, conversation: present({ status: conversation.status, conversation_id: conversation.conversation_id,
      revision: conversation.revision, read: { tool: 'resume_agent_conversation',
        arguments: { taskContextToken: value.taskContextToken, conversationId: conversation.conversation_id } } }) };
  },
  // A manager keeps its trigger sentence and rules inline (#407); the rest is its read.
  value => {
    const managers = value.project_management_context?.managers;
    return managers?.length ? { ...value, project_management_context: { ...value.project_management_context,
      managers: managers.map(manager => present({ agent_id: manager.agent_id, name: manager.name,
        guidance: manager.guidance ? present({ summary: manager.guidance.summary, rules: manager.guidance.rules,
          version: manager.guidance.version }) : undefined, read: managerRead(manager) })) } }
      : null;
  }
]);

// A layer at its least: its revision (a checkpoint names the one it read),
// that it must be read in full before it is written, and that read.
function leanMemoryPointer(memory, read) {
  return present({ revision: memory.revision, view: 'omitted', requiresFullReadBeforeWrite: memory.requiresFullReadBeforeWrite,
    read });
}
