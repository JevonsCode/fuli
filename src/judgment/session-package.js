import { ApplicationError } from '../app/application-error.js';
import { taskKnowledgeReader } from '../graphiti/knowledge-reader.js';
import { readJudgmentPreferences } from './preference-receipt.js';
import { visibleKnowledgeKeys } from './visible-items.js';

// What a session that answers for Tonborg receives (rec#11 D-58, rec#50).
// Without a configured model, Tonborg's judgment becomes a work package for a
// session (D-04 §6). Tonborg's own model reads the full context: its memory,
// earlier decisions and their feedback, and preferences given to Tonborg. A
// session is another reader, so the package it claims holds only what judging
// needs: the candidates' own fields, the task evidence, the policy and
// criteria, and those of the package's preferences this session may read now.
// Tonborg's memory and history stay out. A review whose candidate this
// session may not see now, or whose visibility cannot be read, is not handed
// over. The stored package keeps the full request, and the rerun that uses
// the answer reads its context again; only the claimed view changes.

// Tonborg's memory and its earlier decisions with their feedback (engine.js context).
const MODEL_ONLY = Object.freeze(['memory', 'memoryRevision', 'feedback']);
// Marks a receipt the session receives with less than the review was asked
// with, so its rules (PREFERENCE_RECEIPT_RULES) make the session escalate.
const CONTEXT_CHANGED = 'context_changed';

// app: the application whose preference delivery reads as this session's
// reader; evidence: [{ id, text }] of the package request; work: the package;
// session: the claiming session (role-work-sessions.js).
export async function tonborgSessionEvidence(app, evidence, work, session) {
  const task = taskKnowledgeReader(session);
  // An FLA reads as itself only in its own project; elsewhere as a plain session.
  const reader = task?.personalProjectId === work.scope.personalProjectId ? task : null;
  const kept = evidence.filter(item => !MODEL_ONLY.includes(item.id));
  const candidates = kept.find(item => item.id === 'candidates');
  if (candidates) await assertCandidatesVisible(app.personal, work.scope.personalSpaceId, reader, JSON.parse(candidates.text));
  return Promise.all(kept.map(async item => item.id === 'preferences'
    ? { ...item, text: JSON.stringify(await readablePreferences(app, JSON.parse(item.text), work, reader)) } : item));
}

// The stored receipt's rules this reader may read now: each one kept only
// while the reader's own preference delivery still delivers the same rule
// (key and text; the receipt keeps no item ID). The current rules are
// never swapped in, since the review was asked with the stored ones; any rule
// withheld, any current rule or scope_unknown key the receipt lacks, or a
// delivery now less complete than the receipt marks the context changed.
// A delivery that cannot be read withholds every rule.
async function readablePreferences(app, receipt, work, reader) {
  if (receipt.status === 'unavailable') return receipt;
  const current = await readJudgmentPreferences(app, { personalProjectId: work.scope.personalProjectId,
    projectAgentId: reader?.projectAgentId ?? null, taskScope: receiptTaskScope(receipt.scope) });
  const now = current.status === 'unavailable' ? { selected: [], conflicts: [], scope_unknown: [] } : current;
  let changed = current.status === 'unavailable';
  // A stored rule is readable while the same key delivers the same text; a
  // scope that moved since (made one FLA's, say) still changes the context.
  const readable = (stored, delivered, sign) => {
    const scopes = new Map(delivered.map(item => [sign(item), item.scope]));
    const kept = stored.filter(item => scopes.has(sign(item)));
    if (kept.length < stored.length || delivered.length > kept.length
      || kept.some(item => scopes.get(sign(item)) !== item.scope)) changed = true;
    return kept;
  };
  const selected = readable(receipt.selected, now.selected, rule);
  const conflicts = readable(receipt.conflicts, now.conflicts, conflict);
  const scopeUnknown = receipt.scope_unknown.filter(key => now.scope_unknown.includes(key));
  if (scopeUnknown.length < receipt.scope_unknown.length || now.scope_unknown.length > scopeUnknown.length) changed = true;
  // The delivery itself got worse than the receipt (a source window cut since,
  // say) with the same rules: the session is told only that its context changed,
  // never which keys or windows are new.
  if (current.status !== 'unavailable') {
    const worse = receipt.status === 'complete' && current.status !== 'complete';
    const newlyCut = current.omitted.truncated.some(window => !receipt.omitted.truncated.includes(window));
    if (worse || newlyCut) changed = true;
  }
  if (!changed) return receipt;
  return { ...receipt, status: 'partial', context_changed: true, selected, conflicts, scope_unknown: scopeUnknown,
    omitted: { ...receipt.omitted, truncated: [...new Set([...receipt.omitted.truncated, CONTEXT_CHANGED])] } };
}

const rule = item => JSON.stringify([item.key, item.rule]);
const conflict = item => JSON.stringify([item.key, item.alternatives.map(side => side.rule).sort()]);

// The task dimensions the stored receipt was read with. A session-limited
// rule is not read again (no session is named), so it is withheld.
function receiptTaskScope(scope) {
  const known = value => value && value !== 'unknown' ? value : null;
  return { workKind: known(scope?.work_kind), workflow: known(scope?.workflow) };
}

async function assertCandidatesVisible(personal, personalSpaceId, reader, candidates) {
  const keys = candidates.map(candidate => candidate.candidate_key);
  const { visible, unavailable } = await visibleKnowledgeKeys(personal, { personalSpaceId, reader }, keys);
  if (keys.every(key => visible.has(key))) return;
  if (unavailable) {
    throw new ApplicationError('role_work_visibility_unavailable', 'FULI could not check that this session may read the knowledge in this work. Try again.',
      { status: 503 });
  }
  throw new ApplicationError('role_work_not_visible', 'This work names knowledge this session may not read. A session that may read it, or Tonborg\'s model, can answer it.',
    { status: 403 });
}
