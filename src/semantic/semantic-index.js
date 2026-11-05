import { randomUUID } from 'node:crypto';

import { KNOWLEDGE_EMBEDDING_OPERATION, SEMANTIC_ROLE } from '../model-backends/config.js';

// Search by meaning (rec#88): FULI ships no model. When a person connected one
// for semantic search, this fills the graph's meaning index with it: the
// Provider lists items whose vector is missing or stale for that model, this
// embeds them and hands the vectors back. Only projects the person approved
// for that model are sent; the rest stay pending and are searched by words.
// The index is derived data: no version, no review, nothing a person confirms.

const PAGE = 32;
// A query vector is kept a while: an entry searches several times, a person retypes.
const QUERY_CACHE_MS = 10 * 60_000;
const QUERY_CACHE_SIZE = 200;
const queryCache = new Map();

// The model whose vectors the graph keeps, or null when none is connected.
export function semanticModel(application) {
  const settings = application.modelBackends?.operationSettings(SEMANTIC_ROLE, KNOWLEDGE_EMBEDDING_OPERATION);
  return settings?.connection?.model ?? null;
}

// One pass over what is pending. Answers { status, embedded, skipped, refused },
// where status is off, done, stopped (a model call failed) or superseded (the
// model changed under it). onProgress is called after each page.
export async function fillSemanticIndex(application, { signal = null, onProgress = () => {} } = {}) {
  const model = semanticModel(application);
  if (!model) return { status: 'off', embedded: 0, skipped: 0, refused: 0 };
  const personalSpaceId = application.config.personal.spaceId;
  const counts = { embedded: 0, skipped: 0, refused: 0 };
  let after = null;
  do {
    if (signal?.aborted) return { status: 'stopped', ...counts };
    if (semanticModel(application) !== model) return { status: 'superseded', ...counts };
    const page = await application.personal.semanticPending({ personalSpaceId, model, limit: PAGE, ...(after ? { after } : {}) });
    for (const [personalProjectId, items] of byProject(page.items ?? [])) {
      const request = embeddingRequest(personalSpaceId, personalProjectId, items.map(item => item.text));
      if (!application.modelBackends.allowsEgress(request)) {
        counts.refused += items.length;
        continue;
      }
      const answer = await application.modelBackends.embed(request);
      if (!answer.vectors) return { status: 'stopped', reason: answer.modelReceipt?.reason ?? null, ...counts };
      const written = await application.personal.writeSemanticVectors({ personalSpaceId, model,
        items: items.map((item, index) => ({ item_kind: item.item_kind, item_id: item.item_id, hash: item.hash, vector: answer.vectors[index] })) });
      counts.embedded += written.written ?? 0;
      counts.skipped += written.skipped?.length ?? 0;
    }
    onProgress(counts);
    after = page.next ?? null;
  } while (after);
  return { status: 'done', ...counts };
}

// A query's own vector, or null: no model, a project not approved, a failure
// or too slow. Search then goes on by words alone.
export async function queryVector(application, { personalProjectId = null, query, timeoutMs }) {
  const model = semanticModel(application);
  if (!model || typeof query !== 'string' || !query.trim()) return null;
  const text = query.slice(0, 2048);
  const request = embeddingRequest(application.config.personal.spaceId, personalProjectId, [text], timeoutMs);
  if (!application.modelBackends.allowsEgress(request)) return null;
  const key = `${model}\n${text}`;
  const kept = queryCache.get(key);
  if (kept && Date.now() - kept.at < QUERY_CACHE_MS) return { model, vector: kept.vector };
  try {
    const answer = await application.modelBackends.embed(request);
    const vector = answer.vectors?.[0];
    if (!vector) return null;
    queryCache.delete(key);
    queryCache.set(key, { at: Date.now(), vector });
    if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value);
    return { model, vector };
  } catch {
    return null;
  }
}

function embeddingRequest(personalSpaceId, personalProjectId, texts, timeoutMs = null) {
  return { role: SEMANTIC_ROLE, operation: KNOWLEDGE_EMBEDDING_OPERATION, requestId: `semantic:${randomUUID()}`,
    scope: { personalSpaceId, personalProjectId, sessionRef: null }, texts,
    ...(timeoutMs ? { budget: { timeoutMs } } : {}) };
}

function byProject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.personal_project_id ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
