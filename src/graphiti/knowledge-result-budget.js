import { createHash } from 'node:crypto';
import { ApplicationError } from '../app/application-error.js';
import { createFuliSourceMarker } from './source-marker.js';

export const AUTOMATIC_RECALL_BYTES = 4 * 1024;
export const SEARCH_PAGE_BYTES = 8 * 1024;
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

export function utf8Preview(value, limit) {
  if (Buffer.byteLength(value) <= limit) return value;
  let text = '';
  for (const point of value) {
    if (Buffer.byteLength(text + point + '…') > limit) break;
    text += point;
  }
  return text + '…';
}

function itemPreview(item, textBytes) {
  const result = { ...item };
  delete result.attributes;
  for (const key of ['name', 'type', 'source_entity', 'target_entity', 'relationship', 'fact', 'summary']) {
    if (typeof result[key] !== 'string') continue;
    const limited = utf8Preview(result[key], ['fact', 'summary'].includes(key) ? textBytes : 160);
    if (limited !== result[key]) result.text_truncated = true;
    result[key] = limited;
  }
  const sources = Array.isArray(item.source_uris) ? item.source_uris : [];
  result.source_uris = sources.filter(uri => typeof uri === 'string' && Buffer.byteLength(uri) <= 768).slice(0, 2);
  if (sources.length > result.source_uris.length) result.source_uris_omitted = sources.length - result.source_uris.length;
  return result;
}

function marker(value, consoleUrl) {
  return createFuliSourceMarker({ ...value, consoleUrl, projectScopePriority: 'strict' });
}

export function budgetAutomaticRecall(value, { consoleUrl, compare }) {
  const entries = [...value.facts.map(item => ({ kind: 'facts', item })),
    ...value.entities.map(item => ({ kind: 'entities', item }))].sort((a, b) => compare(a.item, b.item));
  const selected = [];
  const render = () => {
    const facts = selected.filter(entry => entry.kind === 'facts').map(entry => entry.view);
    const entities = selected.filter(entry => entry.kind === 'entities').map(entry => entry.view);
    return { ...value, status: selected.length ? 'matched' : 'budget_exhausted', facts, entities,
      sourceMarker: marker({ facts, entities }, consoleUrl),
      retrieval_budget: { limit_bytes: AUTOMATIC_RECALL_BYTES, returned_items: selected.length,
        omitted_items: entries.length - selected.length,
        truncated: selected.length < entries.length || selected.some(entry => entry.view.text_truncated || entry.view.source_uris_omitted) } };
  };
  for (const entry of entries) {
    for (const size of [800, 400, 160]) {
      const candidate = { ...entry, view: itemPreview(entry.item, size) };
      selected.push(candidate);
      if (jsonBytes(render()) <= AUTOMATIC_RECALL_BYTES) break;
      selected.pop();
    }
  }
  return render();
}

// Cursor contents are opaque hashes and offsets, never a cached authorization
// or a local path. Every continuation re-runs the same scoped search first.
export function budgetKnowledgeSearch(value, { cursor, context, consoleUrl,
  toolName = 'search_knowledge_graph' } = {}) {
  value = safeSearchValue(value);
  const compound = Array.isArray(value.results);
  const groups = compound ? value.results : [value];
  const lists = groups.map(group => {
    const result = [];
    for (let i = 0; i < Math.max(group.facts?.length ?? 0, group.entities?.length ?? 0); i++) {
      for (const kind of ['facts', 'entities']) if (group[kind]?.[i]) result.push({ kind, item: group[kind][i] });
    }
    return result;
  });
  const entries = [];
  for (let i = 0; i < Math.max(0, ...lists.map(list => list.length)); i++) {
    lists.forEach((list, group) => { if (list[i]) entries.push({ ...list[i], group }); });
  }
  for (const entry of entries) {
    // Search scores/view counters are volatile; the record body stays stable
    // while a read itself updates those counters.
    const { score, weight, weight_percent, confirmed_by_person, last_agent_viewed_at, ...body } = entry.item;
    entry.serialized = JSON.stringify(body);
  }
  const digest = createHash('sha256').update(JSON.stringify({ context,
    records: entries.map(entry => entry.serialized) })).digest('hex');
  const encode = (index, offset = 0) => `v1.${digest}.${index}.${offset}`;
  let index = 0, offset = 0;
  if (cursor !== undefined && cursor !== null) {
    const match = /^v1\.([a-f0-9]{64})\.(\d+)\.(\d+)$/.exec(cursor);
    if (!match || match[1] !== digest) throw staleCursor();
    [index, offset] = match.slice(2).map(Number);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset) || index >= entries.length
      || offset >= Array.from(entries[index].serialized).length) throw staleCursor();
  }
  const whole = { ...value, retrieval_budget: { limit_bytes: SEARCH_PAGE_BYTES, complete: true } };
  if (!cursor && jsonBytes(whole) <= SEARCH_PAGE_BYTES) return whole;
  const bases = groups.map(searchMetadata);
  const selected = [];
  const render = (nextIndex, nextOffset = 0) => {
    const rendered = bases.map((base, group) => {
      const local = selected.filter(entry => entry.group === group);
      const facts = local.filter(entry => entry.kind === 'facts').map(entry => entry.view);
      const entities = local.filter(entry => entry.kind === 'entities').map(entry => entry.view);
      return { ...base, facts, entities, sourceMarker: marker({ facts, entities }, consoleUrl),
        noMatchSourceMarker: marker({}, consoleUrl) };
    });
    const next = nextIndex < entries.length ? encode(nextIndex, nextOffset) : null;
    return { ...(compound ? { ...searchMetadata(value), results: rendered } : rendered[0]),
      retrieval_budget: { limit_bytes: SEARCH_PAGE_BYTES, complete: !next, returned_items: selected.length },
      ...(next ? { next_cursor: next, continuation_tool: 'fuli_call', continuation_tool_name: toolName,
        continuation_guidance: 'Repeat the same search and scope with next_cursor as cursor through fuli_call; do not widen scope.' } : {}) };
  };
  for (; index < entries.length; index++, offset = 0) {
    const entry = entries[index];
    if (!offset) {
      selected.push({ ...entry, view: entry.item });
      if (jsonBytes(render(index + 1)) <= SEARCH_PAGE_BYTES) continue;
      selected.pop();
      if (selected.length) return render(index);
    }
    const points = Array.from(entry.serialized);
    const preview = itemPreview(identityPreview(entry.item), 256);
    const candidate = { ...entry, view: preview };
    selected.push(candidate);
    const fragment = count => {
      candidate.view = { ...preview, content_truncated: true, details_fragment: {
        encoding: 'json', offset, total_length: points.length,
        text: points.slice(offset, offset + count).join('') } };
      return offset + count < points.length ? render(index, offset + count) : render(index + 1);
    };
    let low = 0, high = points.length - offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(fragment(middle)) <= SEARCH_PAGE_BYTES) low = middle;
      else high = middle - 1;
    }
    if (!low) throw new ApplicationError('result_too_large', 'Search metadata exceeds the page budget; use fewer focused queries or project scopes');
    return fragment(low);
  }
  const result = render(index);
  if (jsonBytes(result) > SEARCH_PAGE_BYTES) throw new ApplicationError('result_too_large', 'Search metadata exceeds the page budget; use fewer focused queries');
  return result;
}

function identityPreview(item) {
  return Object.fromEntries(['id', 'space_id', 'scope', 'key', 'defined_project_id',
    'inherited_from_project_id', 'scope_distance', 'confirmation_status', 'score',
    'name', 'type', 'source_entity', 'target_entity', 'relationship', 'fact', 'summary', 'source_uris']
    .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}

function searchMetadata(value) {
  const { facts, entities, results, sourceMarker, noMatchSourceMarker, subscriptions,
    relatedProjectSuggestions, related_project_suggestions, ...rest } = value;
  const result = { ...rest };
  if (typeof result.query === 'string') result.query = utf8Preview(result.query, 256);
  if (subscriptions?.length) result.subscriptions_omitted = subscriptions.length;
  for (const [key, items] of [['relatedProjectSuggestions', relatedProjectSuggestions],
    ['related_project_suggestions', related_project_suggestions]]) {
    if (!Array.isArray(items)) continue;
    result[key] = items.slice(0, 3).map(item => ({ ...item,
      project_name: typeof item.project_name === 'string' ? utf8Preview(item.project_name, 160) : item.project_name,
      reason: typeof item.reason === 'string' ? utf8Preview(item.reason, 256) : item.reason }));
    if (items.length > 3) result.related_suggestions_omitted = items.length - 3;
  }
  // Detailed suggestions remain available on focused queries. Permission flags
  // and exact confirmed_search targets above are retained, never inferred.
  for (const key of ['relatedProjectGuidance', 'related_project_guidance']) {
    if (typeof result[key] === 'string') result[key] = utf8Preview(result[key], 512);
  }
  return result;
}

const staleCursor = () => new ApplicationError('validation', 'Search cursor is stale or belongs to different evidence, query or scope; restart without cursor');

// These fields were omitted by the generic MCP sanitizer. Exact page delivery
// must keep that boundary before serializing records into continuation text.
const PRIVATE_FIELDS = new Set(['store', 'dbpath', 'databasepath', 'privatepath', 'snapshot', 'fullsnapshot']);
function safeSearchValue(value, depth = 0) {
  if (depth > 64) throw new ApplicationError('validation', 'Knowledge metadata exceeds the supported depth');
  if (Array.isArray(value)) return value.map(item => safeSearchValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.has(key.replace(/[_-]/g, '').toLowerCase()))
    .map(([key, item]) => [key, safeSearchValue(item, depth + 1)]));
}
