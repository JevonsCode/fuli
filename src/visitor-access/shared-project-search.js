import { withoutLocalPaths } from '../text/local-paths.js';
import { utf8Preview } from '../text/utf8-preview.js';

// What a visitor from another computer may read of one shared project: that
// project's own current, confirmed, normal-sensitivity knowledge and nothing
// around it. Every scope switch is fixed here; a caller passes only the
// project and the queries, so no caller can widen the search. No personal-
// global item, no parent or related project, no pending or historical item,
// no FLA memory, no query vector (it would send the query to a model), no
// title index on a miss and no related-project names.
const MAX_QUERIES = 4;
const MAX_QUERY_CHARS = 200;
const RESULTS_PER_QUERY = 8;
const MAX_ANSWER_BYTES = 16 * 1024;
const CUT_MARK = '…';
// What the project's entry or the person's profile is, not project knowledge;
// a source entity may name a local repository.
const NOT_SHARED_TYPES = new Set(['PersonalProject', 'ProjectSource', 'PersonalPreference']);

// projectId: checked by the caller. Answers { code } when the queries cannot be
// searched, otherwise the queries as searched (each cut to MAX_QUERY_CHARS),
// the answer { results, truncated } and its serialized size.
export async function searchSharedProject(application, { projectId, queries: asked }) {
  const queries = searchableQueries(asked);
  if (typeof queries === 'string') return { code: queries };
  const personalSpaceId = application.config.personal.spaceId;
  const found = await Promise.all(queries.map(query => application.personal.search({
    space_ids: [personalSpaceId],
    query,
    limit: RESULTS_PER_QUERY,
    include_historical: false,
    include_pending: false,
    personal_project_ids: [projectId],
    active_personal_project_id: projectId,
    project_agent_id: null,
    inherit_project_knowledge: false,
    include_personal_global: false,
    max_sensitivity: 'normal'
  })));
  return { queries, ...boundedAnswer(queries.map((query, index) => ({ query, items: sharedItems(found[index], projectId) }))) };
}

// One to MAX_QUERIES non-empty texts, each trimmed and cut to MAX_QUERY_CHARS
// code points; a refusal code otherwise.
function searchableQueries(asked) {
  if (!Array.isArray(asked) || !asked.length) return 'queries_missing';
  if (asked.length > MAX_QUERIES) return 'too_many_queries';
  const queries = asked.map(query => (typeof query === 'string' ? [...query.trim()].slice(0, MAX_QUERY_CHARS).join('') : ''));
  return queries.every(Boolean) ? queries : 'query_invalid';
}

// The provider already scoped the search; an item that still names another
// scope, an FLA or the person's preferences is left out rather than trusted.
function sharedItems(result, projectId) {
  const inProject = item => item.defined_project_id === projectId && !item.inherited
    && !item.project_agent_id && !item.profile_aspect;
  const facts = (result?.facts ?? []).filter(inProject)
    .map(fact => ({ score: fact.score ?? 0, item: { kind: 'fact', title: fact.relationship, text: fact.fact } }));
  const entities = (result?.entities ?? []).filter(entity => inProject(entity) && !NOT_SHARED_TYPES.has(entity.type))
    .map(entity => ({ score: entity.score ?? 0, item: { kind: entity.type, title: entity.name, text: entity.summary } }));
  return [...facts, ...entities].sort((left, right) => right.score - left.score).slice(0, RESULTS_PER_QUERY)
    .map(({ item }) => ({ kind: String(item.kind ?? ''), title: visibleText(item.title), text: visibleText(item.text) }));
}

const visibleText = value => withoutLocalPaths(String(value ?? ''));

// Items in order until the serialized answer would pass MAX_ANSWER_BYTES; the
// item that does not fit is cut to what does, and the rest is left out.
function boundedAnswer(answers) {
  const answer = { results: answers.map(({ query }) => ({ query, items: [] })), truncated: false };
  const size = () => Buffer.byteLength(JSON.stringify(answer));
  for (const [index, { items }] of answers.entries()) {
    const kept = answer.results[index].items;
    for (const item of items) {
      kept.push(item);
      if (size() <= MAX_ANSWER_BYTES) continue;
      answer.truncated = true;
      kept[kept.length - 1] = { ...item, text: '' };
      const room = MAX_ANSWER_BYTES - size();
      if (room <= Buffer.byteLength(CUT_MARK)) kept.pop();
      else kept[kept.length - 1].text = utf8Preview(item.text, room, text => Buffer.byteLength(JSON.stringify(text)) - 2, CUT_MARK);
      return { answer, bytes: size() };
    }
  }
  return { answer, bytes: size() };
}
