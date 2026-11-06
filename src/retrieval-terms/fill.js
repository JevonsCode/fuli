import { askQuestions, askTerms, termsReadiness } from './terms-model.js';

// Filling retrieval terms for old knowledge (rec#92). Three steps the person
// takes one at a time: counting what lacks terms costs nothing; a self-test
// on a small sample measures, with real searches, how many more items are
// found and what one item costs; then a fill writes terms for the rest. The
// self-test writes the sample's terms too, so nothing it paid for is lost.

const SAMPLE_SIZE = 20;
const BATCH = 16;
const TOP = 5;
// The self-test's advice: when items are already found this often, terms are
// not needed; a gain this large is worth the fill.
const ALREADY_FOUND = 0.9;
const WORTH_GAIN = 0.15;
// Before any self-test: characters per token of mixed Chinese and English,
// and the instructions and answer each item adds.
const CHARS_PER_TOKEN = 2;
const TOKENS_PER_ITEM = 80;

export async function termsStats(application, personalProjectId) {
  const stats = await application.personal.retrievalStats({ personalSpaceId: spaceOf(application), personalProjectId });
  const missing = stats.items - stats.with_terms;
  return { ...stats, missing, roughTokens: Math.round(stats.missing_chars / CHARS_PER_TOKEN + missing * TOKENS_PER_ITEM) };
}

export async function trialTerms(application, { personalProjectId, now = () => new Date() }) {
  const readiness = termsReadiness(application, personalProjectId);
  if (readiness !== 'ready') return { status: readiness };
  const personalSpaceId = spaceOf(application);
  const { items: candidates } = await application.personal.retrievalCandidates({
    personalSpaceId, personalProjectId, limit: SAMPLE_SIZE, missingOnly: true });
  if (!candidates.length) return { status: 'nothing_missing' };
  const questions = await askQuestions(application, { personalProjectId, candidates });
  if (!questions.byId.size) return { status: 'model_failed', reason: questions.reason };
  const before = await found(application, personalProjectId, questions.byId);
  const terms = await askTerms(application, { personalProjectId, candidates });
  if (!terms.byId.size) return { status: 'model_failed', reason: terms.reason, tokens: { trial: questions.tokens } };
  const written = await writeTerms(application, candidates, terms.byId);
  const after = await found(application, personalProjectId, questions.byId);
  const stats = await termsStats(application, personalProjectId);
  const perItem = Math.ceil(terms.tokens / candidates.length);
  const sample = questions.byId.size;
  return { status: 'tested', at: now().toISOString(), personalProjectId, sample, before, after,
    written: written.written, remaining: stats.missing,
    tokens: { trial: questions.tokens + terms.tokens, perItem, projected: perItem * stats.missing },
    advice: advice(before / sample, after / sample) };
}

// Terms for every item of the project still without them, a batch per call.
export async function fillTerms(application, { personalProjectId, signal = null, onProgress = () => {} }) {
  const counts = { written: 0, skipped: 0, tokens: 0 };
  let after = null;
  do {
    if (signal?.aborted) return { status: 'stopped', ...counts };
    if (termsReadiness(application, personalProjectId) !== 'ready') return { status: 'superseded', ...counts };
    const page = await application.personal.retrievalCandidates({
      personalSpaceId: spaceOf(application), personalProjectId, limit: BATCH, missingOnly: true,
      ...(after ? { after } : {}) });
    if (page.items.length) {
      const terms = await askTerms(application, { personalProjectId, candidates: page.items });
      counts.tokens += terms.tokens;
      if (!terms.byId.size) return { status: 'model_failed', reason: terms.reason, ...counts };
      const written = await writeTerms(application, page.items, terms.byId);
      counts.written += written.written;
      counts.skipped += page.items.length - written.written;
    }
    onProgress({ ...counts });
    after = page.next ?? null;
  } while (after);
  return { status: 'done', ...counts };
}

export function advice(before, after) {
  if (before >= ALREADY_FOUND) return 'not_needed';
  if (after - before >= WORTH_GAIN) return 'fill';
  return after > before ? 'optional' : 'not_worth';
}

async function writeTerms(application, candidates, byId) {
  const items = candidates.filter(candidate => byId.has(candidate.item_id)).map((candidate) => {
    const { terms, context } = byId.get(candidate.item_id);
    return { item_kind: candidate.item_kind, item_id: candidate.item_id, hash: candidate.hash, terms,
      ...(context ? { context } : {}) };
  });
  if (!items.length) return { written: 0 };
  return application.personal.writeRetrievalTerms({ personalSpaceId: spaceOf(application), items });
}

// How many of the items their question finds in the top results, by words.
async function found(application, personalProjectId, questions) {
  let hits = 0;
  for (const [itemId, query] of questions) {
    const result = await application.personal.search({ space_ids: [spaceOf(application)], query, limit: TOP,
      personal_project_ids: [personalProjectId], active_personal_project_id: personalProjectId });
    const ids = [...(result.entities ?? []), ...(result.facts ?? [])].map(row => row.id);
    if (ids.includes(itemId)) hits += 1;
  }
  return hits;
}

const spaceOf = application => application.config.personal.spaceId;
