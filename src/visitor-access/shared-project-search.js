import { withoutControls } from '../text/control-characters.js';
import { shareableText } from '../text/shareable-text.js';
import { utf8Preview } from '../text/utf8-preview.js';

// What a visitor from another computer may read of one shared project: that
// project's own current, confirmed, normal-sensitivity knowledge and nothing
// around it. Every scope switch is fixed here; a caller passes only the
// project and the queries, so no caller can widen the search. No personal-
// global item, no parent, related or referencing project, no pending or
// historical item, no FLA memory, no query vector (it would send the query to
// a model), no title index on a miss and no related-project names; the
// Provider also leaves out relationships to any entity a visitor may not see.
// The provider's personal project id: 1 to 128 characters; here also no
// surrounding space or control character.
const PROJECT_ID = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,126}[^\s\p{Cc}])?$/u;
const MAX_QUERIES = 4;
const MAX_QUERY_CHARS = 200;
// Longer text is refused before it is read as code points.
const MAX_QUERY_UNITS = 2000;
const RESULTS_PER_QUERY = 8;
// The whole answer the port returns, its ok field included.
const MAX_ANSWER_BYTES = 16 * 1024;
const CUT_MARK = '…';
// What the project's entry or the person's profile is, not project knowledge;
// a source entity may name a local repository.
const NOT_SHARED_TYPES = Object.freeze(['PersonalProject', 'ProjectSource', 'PersonalPreference']);

// One to MAX_QUERIES texts, each refused past MAX_QUERY_UNITS, stripped of
// control and bidirectional characters, then cut to MAX_QUERY_CHARS code
// points; answers the queries to search or a refusal code.
export function searchableQueries(asked) {
  if (!Array.isArray(asked) || !asked.length) return { code: 'queries_missing' };
  if (asked.length > MAX_QUERIES) return { code: 'too_many_queries' };
  if (!asked.every(query => typeof query === 'string' && query.length <= MAX_QUERY_UNITS)) {
    return { code: 'query_invalid' };
  }
  const queries = asked.map(query => [...withoutControls(query)].slice(0, MAX_QUERY_CHARS).join('').trim());
  return queries.every(Boolean) ? { queries } : { code: 'query_invalid' };
}

export function searchableProject(projectId) {
  return typeof projectId === 'string' && PROJECT_ID.test(projectId);
}

// projectId and queries as searchableProject and searchableQueries accept
// them, checked again here: this module is the boundary, so nothing wider
// reaches the Provider whoever calls it. Answers the exact object the port
// returns and its serialized size.
export async function searchSharedProject(application, { projectId, queries }) {
  if (!searchableProject(projectId)) throw new TypeError('A visitor search needs one valid project id');
  if (!Array.isArray(queries) || searchableQueries(queries).queries?.join('\n') !== queries.join('\n')) {
    throw new TypeError('Visitor queries must come from searchableQueries');
  }
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
    include_project_references: false,
    excluded_entity_types: [...NOT_SHARED_TYPES],
    max_sensitivity: 'normal'
  })));
  return boundedAnswer(queries.map((query, index) => ({ query, items: sharedItems(found[index], projectId) })));
}

// The provider already scoped the search; an item that still names another
// scope, an FLA or the person's preferences is left out rather than trusted.
function sharedItems(result, projectId) {
  const inProject = item => item.defined_project_id === projectId && !item.inherited
    && !item.project_agent_id && !item.profile_aspect;
  const facts = (result?.facts ?? []).filter(inProject)
    .map(fact => ({ score: fact.score ?? 0, item: { kind: 'fact', title: fact.relationship, text: fact.fact } }));
  const entities = (result?.entities ?? []).filter(entity => inProject(entity) && !NOT_SHARED_TYPES.includes(entity.type))
    .map(entity => ({ score: entity.score ?? 0, item: { kind: entity.type, title: entity.name, text: entity.summary } }));
  return [...facts, ...entities].sort((left, right) => right.score - left.score).slice(0, RESULTS_PER_QUERY)
    .map(({ item }) => ({ kind: visibleText(item.kind), title: visibleText(item.title), text: visibleText(item.text) }));
}

const visibleText = value => shareableText(withoutControls(value));

// Items in order until the serialized answer would pass MAX_ANSWER_BYTES; the
// item that does not fit is cut to what does, and the rest is left out.
// Measured with truncated false, the longer of its two values.
function boundedAnswer(answers) {
  const answer = { ok: true, results: answers.map(({ query }) => ({ query, items: [] })), truncated: false };
  const size = () => Buffer.byteLength(JSON.stringify(answer));
  for (const [index, { items }] of answers.entries()) {
    const kept = answer.results[index].items;
    for (const item of items) {
      kept.push(item);
      if (size() <= MAX_ANSWER_BYTES) continue;
      kept[kept.length - 1] = { ...item, text: '' };
      const room = MAX_ANSWER_BYTES - size();
      if (room <= Buffer.byteLength(CUT_MARK)) kept.pop();
      else kept[kept.length - 1].text = utf8Preview(item.text, room, text => Buffer.byteLength(JSON.stringify(text)) - 2, CUT_MARK);
      answer.truncated = true;
      return { answer, bytes: size() };
    }
  }
  return { answer, bytes: size() };
}
