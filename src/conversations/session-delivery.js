import { createHash } from 'node:crypto';

// Within one host session, earlier Fuli entries stay in the conversation.
// Repeating unchanged rules and preferences every turn only grows the context,
// so later entries reference the earlier full delivery by digest. Anything
// uncertain (no prior state, compaction, a changed digest) delivers in full.
const RULE_PATHS = [
  ['agent_receipt', 'guidance'],
  ['application_guidance'],
  ['conversation', 'guidance'],
  ['project_agent_context', 'guidance'],
  ['task_guidance'],
  ['preference_field_defaults'],
  ['static_guidance']
];
const PREFERENCE_PATHS = [['effective_preferences']];

export function sessionDeliveryDigests(context) {
  return { rules: digestOf(pick(context, RULE_PATHS)), preferences: digestOf(pick(context, PREFERENCE_PATHS)) };
}

// previous: the digests recorded with the last full delivery in this session,
// or null when unknown. reset: the host compacted or replaced the history.
export function applySessionDelivery(context, previous, { reset = false } = {}) {
  const digests = sessionDeliveryDigests(context);
  // A full entry names its digests so a later reference can be matched to it.
  const full = { context: { ...context, session_delivery: { digests } }, delivered: digests };
  if (!previous || reset) return full;
  const unchanged = Object.keys(digests).filter((key) => previous[key] === digests[key]);
  if (!unchanged.length) return full;
  const reduced = structuredClone(context);
  if (unchanged.includes('rules')) omit(reduced, RULE_PATHS);
  if (unchanged.includes('preferences')) {
    reduced.effective_preferences_count = context.effective_preferences?.length ?? 0;
    omit(reduced, PREFERENCE_PATHS);
  }
  reduced.session_delivery = {
    digests,
    unchanged: unchanged.map((key) => key === 'preferences' ? 'effective_preferences' : key),
    note: 'Unchanged parts are identical to an earlier Fuli entry in this host session with the same digests and '
      + 'still apply. If that entry is no longer visible in this conversation, call get_collaboration_preferences '
      + 'with this sessionId before relying on omitted rules or preferences.'
  };
  return { context: reduced, delivered: digests };
}

function pick(context, paths) {
  return paths.map((path) => path.reduce((node, key) => node?.[key], context) ?? null);
}

function omit(context, paths) {
  for (const path of paths) {
    const parent = path.slice(0, -1).reduce((node, key) => node?.[key], context);
    if (parent && typeof parent === 'object') delete parent[path.at(-1)];
  }
}

function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}
