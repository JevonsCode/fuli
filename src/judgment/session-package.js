import { ApplicationError } from '../app/application-error.js';
import { taskKnowledgeReader } from '../graphiti/knowledge-reader.js';
import { visibleKnowledgeKeys } from './visible-items.js';

// What a session that answers for Tonborg receives (rec#11 D-58, rec#50).
// Without a configured model, Tonborg's judgment becomes a work package for a
// session (D-04 §6). Tonborg's own model reads the full context: its memory,
// earlier decisions and their feedback, and preferences given to Tonborg. A
// session is another reader, so the package it claims holds only what judging
// needs: the candidates' own fields, the task evidence, the preferences any
// reader of the project may see, and the policy and criteria. Tonborg's
// memory and history stay out, and so does a preference given to Tonborg
// unless the session is Tonborg in that project. A review whose candidate
// this session may not see now, or whose visibility cannot be read, is not
// handed over. The stored package keeps the full request, and the rerun that
// uses the answer reads its context again; only the claimed view changes.

const TONBORG = 'employee.tonborg';
// Tonborg's memory and its earlier decisions with their feedback (engine.js context).
const MODEL_ONLY = Object.freeze(['memory', 'memoryRevision', 'feedback']);
// Marks the preference receipt as partial, so its rules make the session escalate.
const WITHHELD_WINDOW = 'tonborg_scope';

// evidence: [{ id, text }] of the package request; work: the package; session:
// the claiming session (role-work-sessions.js).
export async function tonborgSessionEvidence(personal, evidence, work, session) {
  const reader = taskKnowledgeReader(session);
  const ownTonborg = reader?.projectAgentId === TONBORG && reader.personalProjectId === work.scope.personalProjectId;
  const shown = evidence.filter(item => !MODEL_ONLY.includes(item.id)).map(item => item.id === 'preferences'
    ? { ...item, text: JSON.stringify(sessionPreferences(JSON.parse(item.text), ownTonborg)) } : item);
  const candidates = shown.find(item => item.id === 'candidates');
  if (candidates) await assertCandidatesVisible(personal, work.scope.personalSpaceId, reader, JSON.parse(candidates.text));
  return shown;
}

function sessionPreferences(receipt, ownTonborg) {
  if (ownTonborg || receipt.status === 'unavailable') return receipt;
  const anyReader = item => item.scope !== 'agent';
  const selected = receipt.selected.filter(anyReader), conflicts = receipt.conflicts.filter(anyReader);
  // scope_unknown names keys only, without their scope: none is handed over.
  const withheld = selected.length < receipt.selected.length || conflicts.length < receipt.conflicts.length
    || receipt.scope_unknown.length > 0;
  if (!withheld) return receipt;
  return { ...receipt, status: 'partial', selected, conflicts, scope_unknown: [],
    omitted: { ...receipt.omitted, truncated: [...receipt.omitted.truncated, WITHHELD_WINDOW] } };
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
