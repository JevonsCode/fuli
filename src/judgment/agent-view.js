import { providerReaderFields } from '../graphiti/knowledge-reader.js';
import { judgmentHumanInteraction } from './conversation.js';

// What an Agent reads of Tonborg's local records (rec#50). A record keeps what
// was decided and what ran, never its words: the summary, evidence, reasons,
// objective and titles may hold text from Tonborg's scoped preferences, memory
// or feedback, and from an item that has since become one FLA's. The target of
// a knowledge review is shown only while the reader may see that item now, by
// the Provider's rule (knowledge_visibility.py); a hidden, deleted or
// unreadable one is withheld with it, its title too. Every field this list
// does not name is withheld and listed in content_withheld, so a field added
// later stays out until someone decides it is structure. The person's console
// reads the full records (judgment/http.js); this view is for Agent tools.

const KNOWLEDGE_TARGET = /^(entity|relationship):(.+)$/;
// The Provider's visible-items limit per read.
const VISIBILITY_BATCH = 100;
const RECEIPT = ['status', 'outcome', 'reason', 'reviewId', 'taskId', 'revision'];
const FEEDBACK = ['revision', 'vote', 'createdAt'];
const EXECUTION = { status: true, createdAt: true, receipt: RECEIPT };
const KEPT = Object.freeze({
  id: true, kind: true, personalProjectId: true, createdAt: true, outcome: true, proposedOutcome: true,
  confidence: true, aiReview: true, disposition: true, selection: true, conversationId: true,
  executionRequired: true, agentId: true, workKind: true, taskRevision: true, artifactRevision: true,
  evaluationId: true, requestFingerprint: true, evidenceFingerprint: true, policy: true, policyVersion: true,
  memoryRevision: true, client: true, model: true, sessionId: true, judgedBy: true, modelReceipt: true,
  error: true, guidance: true, workPackage: true, hard_deleted: true,
  // State and counts; the preference keys stay out.
  preferenceDelivery: ['version', 'status', 'reason', 'scope', 'selected', 'truncated'],
  verification: ['attempt_id', 'artifact_revision', 'outcome', 'verifier_id', 'run_id'],
  feedback: FEEDBACK, feedbackHistory: FEEDBACK, execution: EXECUTION, executionHistory: EXECUTION
});
// Targets that name no knowledge: a routing action, an accepted task's ID, a review run.
const PLAIN_TARGETS = Object.freeze({ routing: () => true, acceptance: () => true, review: target => target === 'review' });

// result: a judgment service answer (one record, or { records, ... } with
// its human_interaction). reader: the FLA reading in its project, or null
// for a plain session.
export async function agentJudgmentView(personal, result, { personalSpaceId, reader = null }) {
  const listed = Array.isArray(result?.records);
  const records = listed ? result.records : [result];
  const targets = await visibleTargets(personal, { personalSpaceId, reader }, records);
  const shown = records.map(record => agentRecord(record, targets));
  if (!listed) return shown[0];
  // The question is asked again from what this reader may see.
  const rest = { ...result };
  delete rest.human_interaction;
  return { ...rest, ...judgmentHumanInteraction(shown, personalSpaceId), records: shown };
}

// The knowledge targets among these records this reader may see now, one
// Provider read per batch. A read that fails leaves the rest unknown.
async function visibleTargets(personal, { personalSpaceId, reader }, records) {
  const keys = [...new Set(records.filter(record => record.kind === 'review').map(record => record.target)
    .filter(target => KNOWLEDGE_TARGET.test(target ?? '')))];
  const visible = new Set();
  try {
    for (let start = 0; start < keys.length; start += VISIBILITY_BATCH) {
      const items = keys.slice(start, start + VISIBILITY_BATCH).map(key => {
        const [, item_kind, item_id] = KNOWLEDGE_TARGET.exec(key);
        return { item_kind, item_id };
      });
      const answer = await personal.readVisibleKnowledgeItems({ personal_space_id: personalSpaceId, items,
        ...providerReaderFields(reader) });
      for (const item of answer?.items ?? []) visible.add(`${item.item_kind}:${item.item_id}`);
    }
    return { visible, unavailable: false };
  } catch {
    return { visible, unavailable: true };
  }
}

function agentRecord(record, targets) {
  const withheld = new Set();
  const { target, title, ...rest } = record;
  const shown = project(rest, KEPT, '', withheld);
  const knowledge = record.kind === 'review' && KNOWLEDGE_TARGET.test(target ?? '');
  if (knowledge ? targets.visible.has(target) : PLAIN_TARGETS[record.kind]?.(target)) {
    shown.target = target;
    // A review's title is its candidate's own name (engine.js); any other title is withheld.
    if (knowledge && title !== undefined) shown.title = title;
    else if (present(title)) withheld.add('title');
  } else {
    if (present(target)) withheld.add('target');
    if (present(title)) withheld.add('title');
    shown.target_withheld = targets.unavailable && knowledge ? 'visibility_unavailable' : 'not_visible';
  }
  return withheld.size ? { ...shown, content_withheld: [...withheld].sort() } : shown;
}

// rule: true keeps a value as it is; a list keeps those keys of an object; a
// map keeps its keys by their own rules. Arrays take the rule per element.
function project(value, rule, path, withheld) {
  if (rule === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => project(item, rule, path, withheld));
  const kept = {};
  for (const [key, field] of Object.entries(value)) {
    const name = path ? `${path}.${key}` : key;
    const fieldRule = Array.isArray(rule) ? rule.includes(key) : rule[key];
    if (fieldRule) kept[key] = project(field, fieldRule, name, withheld);
    else if (present(field)) withheld.add(name);
  }
  return kept;
}

function present(value) {
  return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);
}
