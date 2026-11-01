// Who wrote each project profile field (Jevons 11-02). A person's text is
// authoritative, an Agent's text is a draft it may keep rewriting, and text a
// person edited from an Agent's draft is shared. The Provider stores the
// records and defaults profiles saved before them
// (graph-provider/fuli_graph/project_profile_authors.py).
const AUTHORED_FIELDS = Object.freeze(['purpose', 'scope', 'technical_summary', 'boundaries']);

// Mirrors the knowledge weights the console explains: a person 100%, an Agent's
// draft below an Agent-confirmed fact.
const AUTHOR_WEIGHTS = Object.freeze({ person: 100, both: 90, agent: 50 });

// A person's save keeps the Agent as co-author while at least this share of
// the previous text's character pairs is still there.
const KEPT_SHARE_FOR_BOTH = 0.4;

export const PERSON_WRITER = Object.freeze({ kind: 'person' });
// FULI's own drafts (a README excerpt, a bare project name) have no FLA.
export const UNNAMED_AGENT_WRITER = Object.freeze({ kind: 'agent' });

const PERSON_FIELD_REFUSAL = '人写过的字段，请在控制台修改或请用户确认 (written by a person; edit it in the console or ask the user)';

// The profile to store: `next` with each authored field's record decided from
// `previous` (null when the project is new) and who is writing. An Agent never
// overwrites a field a person wrote; that field keeps its previous text and
// is listed in `refused`.
export function applyProfileAuthorship(previous, next, writer, now = new Date()) {
  const updatedAt = now.toISOString();
  const authors = {};
  const refused = [];
  const profile = { ...next };
  for (const field of AUTHORED_FIELDS) {
    const before = fieldText(previous?.[field]);
    const after = fieldText(next[field]);
    const record = previous?.authors?.[field] ?? null;
    if (before === after) {
      if (record && after) authors[field] = record;
      continue;
    }
    if (writer.kind === 'agent' && (record?.kind === 'person' || record?.kind === 'both')) {
      profile[field] = previous[field];
      authors[field] = record;
      refused.push({ field, author: record.kind, reason: PERSON_FIELD_REFUSAL });
      continue;
    }
    if (!after) continue;
    authors[field] = writer.kind === 'agent'
      ? agentRecord('agent', writer, updatedAt)
      : personRecord(record, before, after, updatedAt);
  }
  return { profile: { ...profile, authors }, refused };
}

// One short tag per field for an Agent reading the brief; AI-only text reads as a draft.
export function authorTag(record) {
  const weight = `${record.kind} ${AUTHOR_WEIGHTS[record.kind]}%`;
  return record.kind === 'agent' ? `${weight} AI 草稿，可改` : weight;
}

function personRecord(record, before, after, updatedAt) {
  const coAuthored = (record?.kind === 'agent' || record?.kind === 'both')
    && keptShare(before, after) >= KEPT_SHARE_FOR_BOTH;
  return coAuthored
    ? agentRecord('both', { agentId: record.agent_id, agentName: record.agent_name }, updatedAt)
    : { kind: 'person', updated_at: updatedAt };
}

function agentRecord(kind, { agentId, agentName }, updatedAt) {
  return { kind, ...(agentId ? { agent_id: agentId } : {}), ...(agentName ? { agent_name: agentName } : {}),
    updated_at: updatedAt };
}

function fieldText(value) {
  const lines = Array.isArray(value) ? value : [value];
  return lines.filter(line => typeof line === 'string' && line.trim()).map(line => line.trim()).join('\n');
}

// The share of the previous text's adjacent character pairs (counted with
// repeats) that the new text still has. Pairs, not words, so Chinese text
// without spaces is measured the same way as English.
function keptShare(before, after) {
  const previous = pairs(before);
  if (!previous.length) return 0;
  const available = new Map();
  for (const pair of pairs(after)) available.set(pair, (available.get(pair) ?? 0) + 1);
  let kept = 0;
  for (const pair of previous) {
    const count = available.get(pair) ?? 0;
    if (count) { kept += 1; available.set(pair, count - 1); }
  }
  return kept / previous.length;
}

function pairs(text) {
  const characters = [...text.replace(/\s+/g, ' ')];
  if (characters.length < 2) return characters;
  return characters.slice(1).map((character, index) => characters[index] + character);
}
