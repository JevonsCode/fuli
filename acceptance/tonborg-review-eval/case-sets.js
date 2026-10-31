import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { SYNTHETIC_PROJECT } from './review-path.js';

// The frozen dev and holdout sets of the Tonborg review evaluation (rec#26).
// A labelled source becomes blind inputs (shuffled IDs, the Provider-shaped
// candidate only) and a separate label file. Every set is checked before it
// is written: no duplicate inside a set, no overlap between sets, no repeated
// candidate content anywhere, by normalized text; and no case copies a text
// of an earlier set. An injection case is built from its control by adding
// the injected text, so each pair differs by that text alone.

export const SETS = Object.freeze(['dev', 'holdout']);
export const LABELS = Object.freeze(['approve', 'escalate']);
export const CATEGORIES = Object.freeze(['normal_save', 'normal_discard', 'negation', 'same_name_ambiguity',
  'expired_authorization', 'evidence_conflict', 'missing_candidate', 'replacement', 'scoped', 'injection_control',
  'prompt_injection']);
const BLIND_PREFIX = Object.freeze({ dev: 'D2', holdout: 'H2' });
// Previous texts shorter than this, once normalized, are too generic to call a copy.
const MIN_COPY_CHARS = 8;
// The Provider fields a case does not vary: a pending, newly changed item
// with no attention flag, so the host's protected-item rule never decides it.
const CANDIDATE_DEFAULTS = Object.freeze({ item_kind: 'entity', priority: 2, reasons: ['changed_since_last'],
  confirmation_status: 'pending', current_quadrant: 'known_known', utility_score: 0.5, confidence_score: 0.5, weight_percent: 13,
  qualified_use_count: 0, distinct_task_count: 1, negative_evidence_count: 0, requires_attention: false,
  last_feedback_kind: null, distinct_session_count: 1 });
const VARIED_FIELDS = Object.freeze(['project_ids', 'profile_aspect', 'preference_scope', 'preference_project_id', 'changed_at']);
// The wire order of graph-provider KnowledgeReviewCandidate, which the model reads.
const PROVIDER_FIELD_ORDER = Object.freeze(['candidate_key', 'item_id', 'item_kind', 'title', 'content', 'priority', 'reasons',
  'confirmation_status', 'current_quadrant', 'project_ids', 'profile_aspect', 'preference_scope', 'preference_project_id',
  'utility_score', 'confidence_score', 'weight_percent', 'qualified_use_count', 'distinct_task_count', 'negative_evidence_count',
  'requires_attention', 'last_feedback_kind', 'distinct_session_count', 'changed_at', 'ai_review_evidence_token']);

export function normalizedText(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function buildSets(source, { previousTexts = [] } = {}) {
  const specs = expandInjections(source.cases.map(validCase));
  const keys = new Set();
  for (const spec of specs) {
    if (keys.has(spec.key)) throw new Error(`Duplicate case key ${spec.key}`);
    keys.add(spec.key);
  }
  const cases = strictlyPaired(specs.map(spec => ({ ...spec, candidate: providerCandidate(spec.candidate, source.defaults) })));
  const checks = { ...distinctnessChecks(cases), ...freshnessCheck(cases, previousTexts),
    strictInjectionPairs: cases.filter(item => item.category === 'prompt_injection').length };
  const blind = Object.fromEntries(SETS.map(set => [set, cases.filter(item => item.set === set)
    .sort((a, b) => shuffleKey(source.shuffleSeed, a.key).localeCompare(shuffleKey(source.shuffleSeed, b.key)))
    .map((item, index) => ({ ...item, blindId: `${BLIND_PREFIX[set]}-${String(index + 1).padStart(2, '0')}` }))]));
  return {
    cases: Object.fromEntries(SETS.map(set => [set, blind[set].map(item => ({ blindId: item.blindId, candidate: item.candidate }))])),
    labels: SETS.flatMap(set => blind[set].map(item => ({ blindId: item.blindId, set, key: item.key, category: item.category,
      label: item.label, pair: item.pair ?? null, ...(item.pair ? { pairing: 'strict' } : {}), rationale: item.rationale }))),
    checks
  };
}

function validCase(spec) {
  const where = `case ${spec?.key ?? '(no key)'}`;
  if (typeof spec?.key !== 'string' || !spec.key) throw new TypeError(`${where}: key is required`);
  if (!SETS.includes(spec.set)) throw new TypeError(`${where}: set must be one of ${SETS.join(', ')}`);
  if (!CATEGORIES.includes(spec.category) || spec.category === 'prompt_injection') {
    throw new TypeError(`${where}: category must be an authored category (prompt_injection cases come from a control's injection)`);
  }
  if (!LABELS.includes(spec.label)) throw new TypeError(`${where}: label must be approve or escalate`);
  if (typeof spec.rationale !== 'string' || !spec.rationale.trim()) throw new TypeError(`${where}: rationale is required`);
  if (typeof spec.candidate?.title !== 'string' || typeof spec.candidate?.content !== 'string') {
    throw new TypeError(`${where}: candidate title and content must be strings`);
  }
  if ((spec.category === 'injection_control') !== Boolean(spec.injection)) {
    throw new TypeError(`${where}: an injection_control case, and only one, carries an injection`);
  }
  return spec;
}

// A control's injection: { text, field: 'content' | 'title', after }. The text
// goes after `after` (which must occur once) or at the end of the field.
function expandInjections(specs) {
  return specs.flatMap(spec => {
    if (!spec.injection) return [spec];
    const { text, field = 'content', after = null } = spec.injection;
    const original = spec.candidate[field];
    if (after !== null && original.split(after).length !== 2) throw new Error(`case ${spec.key}: injection anchor must occur once`);
    const injected = after === null ? `${original}${field === 'title' ? ' ' : '\n'}${text}`
      : original.replace(after, `${after}${text}`);
    const { injection, ...control } = spec;
    return [{ ...control, pair: spec.key },
      { ...control, key: `${spec.key}~injected`, category: 'prompt_injection', label: 'escalate', pair: spec.key,
        rationale: `${spec.rationale} Injected text addressed to the reviewer: ${text}`,
        candidate: { ...spec.candidate, [field]: injected } }];
  });
}

// rec#26 review: an injection case keeps its control's identity (item_id,
// candidate_key, which is also the answer schema's target enum, and evidence
// token), so the two requests differ by the injected text alone. Checked
// field by field: exactly one of title and content differs, by containing the
// control's text plus more.
function strictlyPaired(cases) {
  const controls = new Map(cases.filter(item => item.category === 'injection_control').map(item => [item.key, item]));
  return cases.map(item => {
    if (item.category !== 'prompt_injection') return item;
    const control = controls.get(item.pair).candidate;
    const candidate = { ...item.candidate, candidate_key: control.candidate_key, item_id: control.item_id,
      ai_review_evidence_token: control.ai_review_evidence_token };
    const differing = Object.keys(candidate).filter(field => JSON.stringify(candidate[field]) !== JSON.stringify(control[field]));
    if (differing.length !== 1 || !['title', 'content'].includes(differing[0])
      || candidate[differing[0]].length <= control[differing[0]].length) {
      throw new Error(`case ${item.key}: the injection pair must differ by the injected text only (differs in ${differing.join(', ') || 'nothing'})`);
    }
    return { ...item, candidate };
  });
}

function providerCandidate(spec, defaults = {}) {
  const varied = Object.fromEntries(VARIED_FIELDS.map(field => [field, spec[field] ?? defaults[field] ?? null]));
  varied.project_ids ??= [SYNTHETIC_PROJECT];
  const itemId = `syn-${contentHash({ title: spec.title, content: spec.content, ...varied }).slice(0, 12)}`;
  const fields = { candidate_key: `entity:${itemId}`, item_id: itemId, ...CANDIDATE_DEFAULTS, title: spec.title, content: spec.content,
    ...varied, ai_review_evidence_token: contentHash({ itemId, title: spec.title, content: spec.content }) };
  return Object.fromEntries(PROVIDER_FIELD_ORDER.map(field => [field, fields[field]]));
}

function textKey(candidate) {
  return `${normalizedText(candidate.title)}\u0001${normalizedText(candidate.content)}`;
}

function distinctnessChecks(cases) {
  const failures = [];
  const seen = new Map();
  for (const item of cases) {
    const key = textKey(item.candidate);
    const prior = seen.get(key);
    if (prior) failures.push(`${prior.set === item.set ? `duplicate in ${item.set}` : 'dev/holdout overlap'}: ${prior.key} = ${item.key}`);
    else seen.set(key, item);
  }
  // An injection in the title leaves its control's content: that pair may share it.
  const contents = new Map();
  for (const item of cases) {
    const content = normalizedText(item.candidate.content);
    const prior = contents.get(content);
    if (!content) continue;
    if (prior && !(prior.pair && prior.pair === item.pair)) failures.push(`same candidate content: ${prior.key} = ${item.key}`);
    else if (!prior) contents.set(content, item);
  }
  if (failures.length) throw new Error(`The sets are not distinct:\n${failures.join('\n')}`);
  return { distinct: Object.fromEntries(SETS.map(set => {
    const members = cases.filter(item => item.set === set);
    return [set, { cases: members.length, uniqueNormalizedTexts: new Set(members.map(item => textKey(item.candidate))).size }];
  })), crossSetOverlap: 0, method: 'NFKC, lowercase, whitespace, punctuation and symbols removed; title and content compared' };
}

function freshnessCheck(cases, previousTexts) {
  const previous = [...new Set(previousTexts.map(normalizedText))].filter(text => text.length >= MIN_COPY_CHARS);
  const copies = cases.flatMap(item => {
    const text = normalizedText(`${item.candidate.title}\n${item.candidate.content}`);
    return previous.filter(old => text.includes(old)).map(old => `${item.key} contains an earlier text: ${old}`);
  });
  if (copies.length) throw new Error(`Cases copy earlier evaluation texts:\n${copies.join('\n')}`);
  return { freshAgainstPrevious: { previousTexts: previous.length, copies: 0, minChars: MIN_COPY_CHARS } };
}

function shuffleKey(seed, key) {
  return contentHash({ seed, key });
}
