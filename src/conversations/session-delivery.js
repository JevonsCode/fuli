import { createHash } from 'node:crypto';

// Within one host session, earlier Fuli entries stay in the conversation.
// Repeating unchanged rules, preferences and identity every turn only grows the
// context, so an entry may reference a group by digest, but only when the host
// adapter proves that a full delivery of exactly that group is still visible.
// Core rules stay inline on every turn: the receipt, human authority,
// conflicts and the checkpoint contract are never referenced away.
const GROUPS = {
  rules: [
    ['application_guidance', 'global_scope'],
    ['application_guidance', 'project_scope'],
    ['application_guidance', 'agent_scope'],
    ['conversation', 'guidance'],
    ['project_agent_context', 'guidance'],
    ['task_guidance', 'retrieval'],
    ['preference_field_defaults'],
    ['static_guidance']
  ],
  preferences: [['effective_preferences']],
  identity: [
    ['agent_receipt', 'owner'],
    ['agent_receipt', 'continuation'],
    ['project_agent_context', 'role'],
    ['project_agent_context', 'project_brief'],
    ['project_agent_context', 'match_basis'],
    ['judgment_context', 'policy']
  ]
};

// "group:digest" tokens mark full deliveries. References use a different
// shape, so a reference can never be mistaken for a delivery.
export const DELIVERY_TOKEN = /\b(rules|preferences|identity):([0-9a-f]{12})\b/g;

export function sessionDeliveryTokens(context) {
  return Object.fromEntries(Object.entries(GROUPS)
    .map(([group, paths]) => [group, `${group}:${digestOf(pick(context, paths))}`]));
}

// isDelivered(token): the adapter's proof that the full group is visible.
export function applySessionDelivery(context, { isDelivered = () => false } = {}) {
  const tokens = sessionDeliveryTokens(context);
  const referenced = Object.keys(tokens).filter((group) => isDelivered(tokens[group]));
  const delivered = Object.keys(tokens).filter((group) => !referenced.includes(group)).map((group) => tokens[group]);
  if (!referenced.length) return { ...context, session_delivery: { delivered } };
  const reduced = structuredClone(context);
  for (const group of referenced) omit(reduced, GROUPS[group]);
  if (referenced.includes('preferences')) reduced.effective_preferences_count = context.effective_preferences?.length ?? 0;
  reduced.session_delivery = {
    delivered,
    referenced: Object.fromEntries(referenced.map((group) => [group, tokens[group].split(':')[1]])),
    note: 'Referenced groups are unchanged from an earlier full Fuli entry in this conversation that carried the '
      + 'same group:digest in session_delivery.delivered; they still apply. If that entry is not visible to you, '
      + 'call get_collaboration_preferences with this sessionId before relying on omitted rules or preferences.'
  };
  return reduced;
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
