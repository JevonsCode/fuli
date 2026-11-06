import { projectStoresNothing } from './project-knowledge-presence.js';
import { createFuliSourceMarker, knowledgeItemTitle, sourceConsoleUrl } from './source-marker.js';
import { knowledgeItemRole } from './knowledge-item-role.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import { budgetAutomaticRecall } from './knowledge-result-budget.js';
import { entryTimeBelow } from '../conversations/entry-time.js';
import { utf8Preview } from '../text/utf8-preview.js';
import { NEUTRAL, usagePriorLookup } from '../knowledge-impressions/ranking-prior.js';
import { promptSentenceKeys, taskStatement, withoutProhibitions } from './task-prompt-statement.js';

const MAX_QUERIES = 4;
const MAX_ITEMS_PER_KIND = 3;
const TOPIC_ONLY = plan => plan.trigger_categories.length === 1 && plan.trigger_categories[0] === 'topic';
const MAX_ITEM_TEXT = 1000;
const CONFIRMED = new Set(['confirmed', 'agent_confirmed']);
// People confirmed every returned item; reading files only to re-check them costs the tokens recall saves.
const CONFIRMED_USE = 'A person confirmed these items: answer from them directly; open files only for what they do not cover.';
const PENDING_NOTE = 'Pending items are agent-proposed and not confirmed by a person; judge them before use.';

const RECALL_INTENTS = Object.freeze([
  {
    category: 'release_delivery',
    // "Git Bash" and "Git for Windows" name a shell, not a delivery (rec#88).
    pattern: /(?:发布|发版|上线|部署|推送|再推|release|publish|push|deploy|ship|rollout|commit|github|\bgit\b(?!\s+(?:bash|for\s+windows)\b))/iu,
    queries: [
      '发布 发版 版本 release publish runbook',
      '推送 提交 push commit GitHub Connector runbook'
    ]
  },
  {
    category: 'access_authentication',
    pattern: /(?:认证|登录|凭据|身份|令牌|密钥|credential|authentication|authorization|login|(?:access|auth|api|bearer|refresh|id)[\s_-]*token|ssh)/iu,
    queries: ['认证 登录 凭据 身份 credential authentication SSH token runbook']
  },
  {
    category: 'artifact_location',
    pattern: /(?:网址|地址|路由|端点|在哪里|在哪儿|哪里|(?:文档|文件).{0,12}(?:位置|路径|在哪)|(?:找|查).{0,12}(?:文档|文件)|\burl\b|route|endpoint|document location|file path|where)/iu,
    queries: ['地址 URL 路由 route endpoint 部署 deployment 文档 document']
  },
  {
    category: 'requirements_architecture_decision',
    pattern: /(?:需求|约束|架构|设计决定|决策|原因|取舍|requirement|constraint|architecture|decision|rationale|tradeoff)/iu,
    queries: ['需求 约束 架构 决策 原因 requirement constraint architecture decision rationale']
  },
  {
    category: 'runbook_method',
    pattern: /(?:怎么(?:做|办|处理|操作|走)?|如何(?:做|处理|操作|进行)?|怎样(?:做|处理|操作)?|(?:什么|哪(?:个|种)|有没有|是否有|给我|提供|使用|采用|遵循|按照|沿用|走).{0,16}(?:方法|方式|流程|步骤)|(?:方法|方式|流程|步骤).{0,16}(?:是什么|有哪些|怎么|如何|怎样|吗|呢|？|\?)|\brunbook\b|\bprocedure\b|\bhow\s+to\b|(?:what|which|show|give|use|follow|existing|documented).{0,24}\bworkflow\b)/iu,
    queries: ['方法 方式 流程 步骤 runbook workflow procedure']
  },
  {
    // rec#63: "our error code convention", "the team that owns the ledger
    // code", "the way we release beta builds" name a stored project fact
    // without saying "previously".
    category: 'project_convention',
    pattern: /(?:约定|规范|惯例|规则|负责人|谁负责|谁来审|我们的|我们(?:一般|通常|都)|convention|policy|\bour\s+[a-z]|\bowns?\b|\bowner\b|who (?:owns|reviews|approves)|the way we|we (?:always|usually|use|agreed|decided))/iu,
    queries: ['约定 规范 规则 负责人 convention policy rule owner']
  },
  {
    category: 'prior_context',
    pattern: /(?:之前|以前|上次|已经存|保存过|记得|照旧|同样|还是用|不用再|先前|约定|定好的|previous|earlier|\bprior\b|last time|remember|same as|again|we (?:decided|agreed|settled|chose))/iu,
    queries: ['先前 方法 规则 决策 runbook previous method decision']
  }
]);

// rec#51 D-59: an implementation or change request that signals no recall
// intent gets a title-only index of what matches it in its exact project. The
// model reads an item on demand; with nothing relevant the recall is as before.
//
// Whether a prompt is a change request is a heuristic, not intent
// classification: one of its clauses opens with a change verb in the
// imperative, after at most a few polite or sequencing words ("please", "can
// you", "then", 请, 帮我, or a 把/给 phrase before the verb). A clause that
// asks (a question word, a trailing question mark or 吗/呢, unless it is a
// "can you" request) or opens with a negation ("don't", 不要) never counts,
// nor does a change word used as a noun ("tests for", "support for").
const CLAUSE_BREAK = /(?<=[?？])|[。！!；;，,\n]+|\.(?:\s+|$)|\s+(?:and\s+then|and|then)\s+/iu;
const POLITE_REQUEST = /^(?:(?:ok(?:ay)?|so|now)\s+)*(?:please\s+)?(?:can|could|would|will)\s+you\b/iu;
const QUESTION = /[?？吗呢]\s*$|什么|为什么|怎么|怎样|如何|是否|是不是|能不能|哪/u;
const CHANGE_VERB_EN = 'fix|add|implement|change|update|refactor|rename|remove|delete|support|migrate|rewrite|replace|test|'
  + 'debug|build|create|improve|optimi[sz]e|extend|wire|handle|make|write|move|split|port|drop|introduce|allow|ensure|'
  + 'enable|disable|convert|cover|adjust|tighten|clean\\s+up';
const CHANGE_CLAUSE_EN = new RegExp('^(?:(?:ok(?:ay)?|so|now|also|first|then|just|please|pls|let\'?s|help\\s+me|'
  + '(?:can|could|would|will)\\s+you|i\\s+(?:need|want|would\\s+like)\\s+(?:you\\s+)?to|we\\s+(?:need|should|must|have)\\s+to)\\s+)*'
  + `(?:${CHANGE_VERB_EN})\\b(?!\\s+(?:for|of|on|is|are|was|were)\\b)`, 'iu');
const CHANGE_CLAUSE_ZH = new RegExp('^(?:(?:请|帮我|帮忙|麻烦|你|再|先|然后|接着|并|顺便|另外|好的?|ok|OK)\\s*)*'
  + '(?:(?:把|给|为|将|对|在)[^，,。]{1,40}?)?'
  + '(?:修复|修改|修正|修一下|修好|改成|改为|改一下|改掉|改进|实现|添加|增加|新增|加上|加个|补上|补充|补齐|补测试|写测试|加测试|测一下|测试一下|'
  + '重构|优化|删除|删掉|去掉|移除|支持|迁移|调整|编写)', 'u');
const MAX_INDEX_ITEMS = 5;
const INDEX_SEARCH_LIMIT = 12;
// Each item is an [id, title] pair: five of them with UUIDs and every title
// cut at this size are at most 444 bytes with their count, 65 fewer than as
// objects; the read line adds 108.
const INDEX_TITLE_BYTES = 40;
// A threshold for starting the one Provider search, not a timeout of its own:
// with less of the entry's time left the entry goes without it, as it goes
// without a model hint. A search already started is cut short like every
// other entry read: the hook's abort signal reaches the Provider request,
// which combines it with its own timeout (AbortSignal.any), and a failed
// search leaves the recall not_needed.
const INDEX_MIN_REMAINING_MS = 2000;
const INDEX_READ = 'Titles of one bounded search: read one with search_current_project_knowledge before relying on it.';
// rec#63: after "searched, no match" models stopped looking and copied a
// stale value from the repository; one quick search is not the whole store.
const MISS_NEXT = 'One quick search only. Before taking a project value or rule (port, command, owner, convention) from repo files, search_current_project_knowledge for it.';
// rec#88: in a project that has stored nothing yet, that search can only miss
// (7 of 12 compounding-eval sessions spent a tool round trip on it).
const EMPTY_NEXT = 'This project has no stored knowledge yet; no further FULI search is needed.';

export const TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE = Object.freeze({
  before_reasking:
    'Before asking the user to repeat a stable project fact or method, inspect task_knowledge_recall and search Fuli when needed.',
  focused_queries:
    'Use one to four focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query.',
  scope:
    'Search only the exact active personal project, its explicitly inheritable knowledge, and the bounded personal-global profile.',
  candidate_selection:
    'Treat automatic matches as candidates. Cite only items that materially support the task; if all are irrelevant, use noMatchSourceMarker. A recall without markers ran no search: show no marker.'
});

// `earlierSentences`: the sentence keys of the session's earlier prompts
// (session-prompt-sentences.js); the plan reads only the task's own text
// (task-prompt-statement.js), so repeated instructions, notes and
// prohibitions never choose its topics or queries (rec#88).
export function planTaskKnowledgeRecall(taskPrompt, { earlierSentences } = {}) {
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim()) {
    return { status: 'not_requested', trigger_categories: [], queries: [] };
  }
  if (detectSensitiveContent(singleLine(taskPrompt).slice(0, 8192)).restricted) {
    return {
      status: 'suppressed_sensitive',
      trigger_categories: [],
      queries: []
    };
  }
  const statementText = ownTaskText(taskPrompt, earlierSentences);
  const prompt = singleLine(statementText).slice(0, 8192);
  const intentPrompt = { artifact_location: withoutRelativeWhere(prompt) };
  const matched = RECALL_INTENTS.filter(({ category, pattern }) =>
    pattern.test(intentPrompt[category] ?? prompt));
  // rec#88: 16 of 20 held-out misses were never searched because the prompt
  // had no cue word. A prompt with words of its own is searched by them; one
  // with none ("继续") has nothing to search for.
  if (!matched.length) {
    const own = ownClauseQueries(statementText);
    return own.length ? { status: 'planned', trigger_categories: ['topic'], queries: own.slice(0, MAX_QUERIES) }
      : { status: 'not_needed', trigger_categories: [], queries: [] };
  }
  // Named targets already focus every query; otherwise the prompt's own
  // clauses go first. File paths and code names are no target: a fact is
  // stored under its concept ("retry policy", "staging port"), so a query
  // of paths and category words matched none of it (rec#63). Focus, targets and
  // clauses read the lead paragraph (focus falls back to the whole prompt when
  // it names nothing): a name in trailing notes ("WSL Ubuntu", "Windows
  // Node" in pasted environment rules) is not what the task is about.
  const statement = leadParagraph(statementText);
  const leadTerms = distinctivePromptTerms(statement);
  const focus = (leadTerms.length ? leadTerms : distinctivePromptTerms(prompt)).join(' ').slice(0, 180);
  // A named target still leaves room for the clauses that name a kept fact
  // ("the same retry behaviour we use for email" beside "SMS"): its focused
  // category queries come first, then those clauses under the same focus
  // (compounding eval: the task's topic was otherwise never searched).
  const targeted = namedTarget(statement);
  const categoryQueries = matched.flatMap(({ queries: values }) => values).map((query) => focus ? `${focus} ${query}` : query);
  const queries = targeted
    ? unique([...categoryQueries, ...ownClauseQueries(statementText, { cuedOnly: true }).map((query) => `${focus} ${query}`)])
    : unique([...ownClauseQueries(statementText), ...categoryQueries]);
  return {
    status: 'planned',
    trigger_categories: matched.map(({ category }) => category),
    queries: queries.slice(0, MAX_QUERIES)
  };
}

// The keys of the session's earlier prompts, recording this prompt's for the
// next one. A sensitive prompt is never recorded, not even by hash.
function sessionSentences(application, taskPrompt, { sourceApplication, sessionId }) {
  const store = application.sessionPromptSentences;
  if (!store || typeof taskPrompt !== 'string' || detectSensitiveContent(singleLine(taskPrompt).slice(0, 8192)).restricted) {
    return new Set();
  }
  return store.exchange(sourceApplication, sessionId, promptSentenceKeys(taskPrompt.slice(0, 16384)));
}

// The text the plan reads: the task's own statement, without its negated
// delivery actions and other prohibitions.
function ownTaskText(taskPrompt, earlierSentences) {
  return withoutProhibitions(positiveDeliveryClauses(taskStatement(taskPrompt.slice(0, 16384), earlierSentences)));
}

// Negation is local to a clause. Positive later clauses remain candidates;
// this plans recall only and never grants permission to perform delivery.
function positiveDeliveryClauses(prompt) {
  const action = '(?:提交|发布|发版|上线|部署|推送|再推|release|publish|push|deploy|ship|rollout|commit)';
  const target = '(?:\\s*(?:代码|变更|code|changes?|this change|(?:到|to\\s+)\\s*GitHub))?';
  // An English list goes on after a comma only while it is a run of actions
  // that a ", or" closes ("commit, push, or create branches"); otherwise the
  // comma starts a new instruction ("Don't push, deploy to staging or
  // production"), and ", and" opens a positive clause. Chinese commas never
  // join a negated list.
  const listed = `(?=(?:${action}${target}\\s*,?\\s*)+or\\b)`;
  const join = `(?:\\s*,\\s*${listed}(?:\\bor\\b\\s*)?|\\s*(?:和|或|以及|并|、|\\band\\b|\\bor\\b)\\s*)`;
  const negated = new RegExp('(?:不要|不用|不必|无需|不得|禁止|暂不|别|不|\\bdo\\s+not\\b|\\bdon\'t\\b|\\bnever\\b|\\bno\\b)'
    + '(?:\\s|再次|再|需要|执行|进行|要|会|自动|直接)*' + action + target
    + '(?:' + join + action + target + ')*', 'giu');
  return prompt.replace(negated, ' ');
}

// A relative "where" right after a comma ("WSL Ubuntu, where `node` is
// installed") describes a place inside a statement; every other "where" may
// ask for one, with or without a question mark ("Find where config.json is
// loaded"). A question keeps even a relative one. A sentence ends at
// punctuation followed by a space, so a file name such as config.json stays whole.
function withoutRelativeWhere(prompt) {
  return prompt.split(/(?<=[.!?])\s+|(?<=[。！？])/u).map((sentence) => (
    /[?？]\s*$/u.test(sentence) ? sentence
      // "Tell me, where is the config file" still asks, question mark or not.
      : sentence.replace(/,\s*where\b(?!\s+(?:is|are|was|were|do|does|did|should|can|could|would|will|to)\b)/giu, ',')
  )).join(' ');
}

export async function recallTaskKnowledge(application, resolution, taskPrompt, { sourceApplication = null, sessionId = null } = {}) {
  const earlierSentences = sessionSentences(application, taskPrompt, { sourceApplication, sessionId });
  const plan = planTaskKnowledgeRecall(taskPrompt, { earlierSentences });
  // The index and the focus filter read the same own text as the plan.
  const ownText = plan.status === 'suppressed_sensitive' ? taskPrompt : ownTaskText(taskPrompt, earlierSentences);
  const unasked = () => knowledgeIndexRecall(application, resolution, ownText, { sourceApplication, sessionId })
    .then(index => index ?? recallWithoutSearch('not_needed', { trigger_categories: [], queries: [] }));
  if (plan.status === 'not_needed') return await unasked();
  if (plan.status !== 'planned') return recallWithoutSearch(plan.status, plan);
  // Without a project, a prompt no cue asked about reads as before.
  if (!resolution.personalProjectId && TOPIC_ONLY(plan)) return await unasked();
  if (!resolution.personalProjectId) {
    return {
      status: 'project_unresolved',
      trigger_categories: plan.trigger_categories,
      query_count: plan.queries.length,
      guidance: taskKnowledgeRetrievalGuidance(),
      facts: [],
      entities: []
    };
  }

  const settlements = await Promise.allSettled(plan.queries.map((query) =>
    application.searchKnowledge({
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: resolution.personalProjectId,
      query,
      limit: 6,
      includeHistorical: false,
      includePending: true,
      sourceApplication, sourceSessionId: sessionId,
      agentInvocation: true,
      agentToolName: 'automatic_task_knowledge_recall'
    })
  ));
  // A personal preference reaches a task only through its scoped
  // effective_preferences, never as recalled knowledge (rec#15 D-27.7).
  const results = settlements
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => ({ facts: withoutPreferences(value.facts), entities: withoutPreferences(value.entities) }));
  const failedQueryCount = settlements.length - results.length;
  const focusTerms = distinctivePromptTerms(singleLine(ownText).slice(0, 8192));
  const factCandidates = confirmedFirst(filterRecallCandidates(results.flatMap(({ facts = [] }) => facts), focusTerms));
  const entityCandidates = confirmedFirst(filterRecallCandidates(results.flatMap(({ entities = [] }) => entities), focusTerms));
  // rec#63: how often Agents used each candidate once shown reorders, within
  // the same place, by a bounded factor on the score; it never drops one.
  const prior = usagePriorLookup(application.recallImpressions, {
    personalSpaceId: application.config.personal.spaceId, facts: factCandidates, entities: entityCandidates });
  const compare = (left, right) => compareRecallItems(left, right, prior);
  const ranked = {
    facts: rankedUnique(factCandidates, 'relationship', compare).slice(0, MAX_ITEMS_PER_KIND).map(compactFact),
    entities: rankedUnique(entityCandidates, 'entity', compare).slice(0, MAX_ITEMS_PER_KIND).map(compactEntity)
  };
  // rec#88: a pending item the task names only in passing waits as a title.
  const { facts, entities, weak } = relevantPending(ranked, ownText);
  if (!facts.length && !entities.length && weak.length) return weakPendingIndex(plan, weak);
  const pendingSlots = Object.entries({ facts, entities })
    .filter(([, items]) => items.some((item) => !isConfirmed(item))).map(([slot]) => slot);
  const sourceMarker = createFuliSourceMarker({
    consoleUrl: application.consoleUrl,
    facts,
    entities,
    projectScopePriority: 'strict'
  });
  // A search by the prompt's own words that found nothing, or failed, costs the
  // entry nothing: it reads as before, when no cue asked for one.
  if (TOPIC_ONLY(plan) && !facts.length && !entities.length) {
    // A search that failed (a stopped hook, a Provider down) asks for no index either.
    return failedQueryCount === settlements.length ? recallWithoutSearch('not_needed', { trigger_categories: [], queries: [] })
      : await unasked();
  }
  const searched = results.length > 0;
  const result = {
    status: facts.length || entities.length
      ? 'matched'
      : failedQueryCount === settlements.length ? 'unavailable' : 'no_match',
    partial: failedQueryCount > 0,
    failed_query_count: failedQueryCount,
    trigger_categories: plan.trigger_categories,
    query_count: plan.queries.length,
    guidance: taskKnowledgeRetrievalGuidance(),
    ...(searched ? {
      sourceMarker,
      noMatchSourceMarker: createFuliSourceMarker({
        consoleUrl: application.consoleUrl
      })
    } : {}),
    ...(pendingSlots.length ? { pending_fallback: { slots: pendingSlots, note: PENDING_NOTE } } : {}),
    ...(searched && !facts.length && !entities.length
      ? { next: await projectStoresNothing(application, resolution.personalProjectId) ? EMPTY_NEXT : MISS_NEXT } : {}),
    ...(answersFromConfirmed(application) && confirmedByPeople([...facts, ...entities])
      ? { confirmed_use: CONFIRMED_USE } : {}),
    facts,
    entities
  };
  return facts.length || entities.length ? budgetAutomaticRecall(result, {
    consoleUrl: application.consoleUrl, compare
  }) : result;
}

// The index tier: one search of the prompt's distinctive terms, read as the
// recall reads (the same reader, no preferences, confirmed first), keeping
// only items the exact project defines that name one of those terms. Null,
// so the entry carries the unchanged not_needed recall, for anything but a
// change request in a resolved project with such a match in time.
// Pending items fill a slot only when nothing confirmed matched (confirmedFirst),
// and a long stated rule shares common project words with almost any task: the
// compounding eval's retry policy came back, whole, for a health-check task
// because both say "channel". A pending item is sent whole when the head of its
// statement (before its first colon or semicolon) shares at least two terms
// with the task's own words; otherwise only its title is listed, to read on
// demand. Confirmed items are never held back here.
const MIN_HEAD_OVERLAP = 2;
function relevantPending({ facts, entities }, ownText) {
  if ([...facts, ...entities].some(isConfirmed)) return { facts, entities, weak: [] };
  const own = contentTerms(ownText);
  const strong = item => [...contentTerms(statementHead(item))].filter(term => own.has(term)).length >= MIN_HEAD_OVERLAP;
  const weak = [...facts.filter(item => !strong(item)).map(item => ({ item, kind: 'relationship' })),
    ...entities.filter(item => !strong(item)).map(item => ({ item, kind: 'entity' }))];
  return { facts: facts.filter(strong), entities: entities.filter(strong), weak };
}

function statementHead(item) {
  return String(item.name ?? item.fact ?? item.summary ?? '').split(/[:：;；]/u)[0];
}

const HEAD_STOP_WORDS = new Set(['and', 'are', 'for', 'our', 'the', 'this', 'that', 'with', 'every', 'all', 'any', 'its', 'from', 'into']);
// Words and Chinese character pairs, a plural reduced to its singular.
function contentTerms(text) {
  const lower = String(text).toLocaleLowerCase('en-US');
  const words = (lower.match(/[a-z][a-z0-9-]{2,}/gu) ?? []).filter(word => !HEAD_STOP_WORDS.has(word) && !CLAUSE_STOP_WORDS.has(word))
    .map(word => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word));
  const han = (lower.replace(CLAUSE_HAN_FILLERS, '').match(/\p{Script=Han}+/gu) ?? []).flatMap(run => [...run].slice(0, -1).map((char, index) => char + run[index + 1]));
  return new Set([...words, ...han]);
}

// Only weakly related pending items matched: their titles, as the index tier lists them.
function weakPendingIndex(plan, weak) {
  return {
    status: 'indexed',
    trigger_categories: plan.trigger_categories,
    query_count: plan.queries.length,
    guidance: taskKnowledgeRetrievalGuidance(),
    knowledge_index: { matched_in_search: weak.length, read: INDEX_READ,
      items: weak.slice(0, MAX_INDEX_ITEMS).map(({ item, kind }) => [item.id, indexTitle(knowledgeItemTitle(item, kind))]) },
    facts: [],
    entities: []
  };
}

async function knowledgeIndexRecall(application, { personalProjectId }, taskPrompt, { sourceApplication, sessionId }) {
  const prompt = singleLine(taskPrompt).slice(0, 8192);
  if (!personalProjectId || !changeRequested(prompt) || entryTimeBelow(INDEX_MIN_REMAINING_MS)) return null;
  let index;
  try {
    index = await projectKnowledgeIndex(application, personalProjectId, prompt,
      { sourceApplication, sessionId, agentToolName: 'automatic_task_knowledge_index' });
  } catch {
    return null;
  }
  if (!index) return null;
  return {
    status: 'indexed',
    trigger_categories: [],
    query_count: 1,
    guidance: taskKnowledgeRetrievalGuidance(),
    knowledge_index: { ...index, read: INDEX_READ },
    facts: [],
    entities: []
  };
}

// The index of one exact project for a text: one search of the text's
// distinctive terms, keeping the items that project itself defines and that
// name one of those terms, confirmed first, as [id, title] pairs. Null when
// the text has no such term (no search) or nothing matches; a failed search
// throws. Task entry's index tier and the @FLG same-session member index
// (group-member-context.js) share it. agentToolName labels the search.
export async function projectKnowledgeIndex(application, personalProjectId, text,
  { sourceApplication, sessionId, agentToolName }) {
  const focusTerms = distinctivePromptTerms(text);
  const focusTokens = recallFocusTokens(focusTerms);
  if (!focusTokens.length) return null;
  const found = await application.searchKnowledge({
    personalSpaceId: application.config.personal.spaceId,
    personalProjectId,
    query: focusTerms.join(' ').slice(0, 180),
    limit: INDEX_SEARCH_LIMIT,
    includeHistorical: false,
    includePending: true,
    sourceApplication, sourceSessionId: sessionId,
    agentInvocation: true,
    agentToolName
  });
  const exact = (items, itemKind) => withoutPreferences(items)
    .filter(item => item.defined_project_id === personalProjectId && !item.inherited_from_project_id
      && recallItemMatchesFocus(item, focusTokens))
    .map(item => ({ ...item, title: knowledgeItemTitle(item, itemKind) }));
  const matches = confirmedFirst([...exact(found?.facts, 'relationship'), ...exact(found?.entities, 'entity')])
    .sort(compareRecallItems);
  if (!matches.length) return null;
  // What this one search returned and kept, not the project's total: the
  // Provider caps each kind at INDEX_SEARCH_LIMIT, and pending items drop
  // out when a confirmed one matched.
  return { matched_in_search: matches.length,
    items: matches.slice(0, MAX_INDEX_ITEMS).map(({ id, title }) => [id, indexTitle(title)]) };
}

// The heuristic described at CLAUSE_BREAK.
function changeRequested(prompt) {
  return prompt.split(CLAUSE_BREAK).some(clause => {
    const text = clause?.trim();
    if (!text || (QUESTION.test(text) && !POLITE_REQUEST.test(text))) return false;
    return CHANGE_CLAUSE_EN.test(text) || CHANGE_CLAUSE_ZH.test(text);
  });
}

// Bounded by the bytes the entry sends, as a JSON string.
function indexTitle(title) {
  return utf8Preview(singleLine(title), INDEX_TITLE_BYTES, text => Buffer.byteLength(JSON.stringify(text)));
}

// An answer can rest on the recovered conversation instead of searched knowledge.
// Without its own marker such a reply could only cite "searched, no match".
export function withRecoveredSource(recall, conversation, { consoleUrl, spaceId, agentId }) {
  if (!recall || recall.status === 'matched' || !conversation?.recovery?.latest_checkpoint || !spaceId || !agentId) return recall;
  const url = `${consoleUrl ?? sourceConsoleUrl()}/agents/${encodeURIComponent(spaceId)}/${encodeURIComponent(agentId)}`;
  return { ...recall, sourceMarker: { required: true, label: 'FULI 来源', status: 'recovered', count: 1,
    leadMarkdown: `**[◇ FULI · 接续上次进度](${url})**`, markdown: '' } };
}

function recallWithoutSearch(status, plan) {
  return {
    status,
    trigger_categories: plan.trigger_categories,
    query_count: plan.queries.length,
    guidance: taskKnowledgeRetrievalGuidance(),
    facts: [],
    entities: []
  };
}

function taskKnowledgeRetrievalGuidance() {
  return { ...TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE };
}

function withoutPreferences(items) {
  return (items ?? []).filter(item => !item?.profile_aspect);
}

// Human-authoritative first: agent-proposed pending items fill a slot only when
// nothing confirmed matched it, so a prior-context task needs no extra search.
function confirmedFirst(items) {
  const confirmed = items.filter(isConfirmed);
  return confirmed.length ? confirmed : items;
}

function isConfirmed(item) {
  return CONFIRMED.has(item?.confirmation_status);
}

function rankedUnique(items, itemKind, compare = compareRecallItems) {
  const selected = new Map();
  for (const item of items) {
    const key = `${itemKind}:${item.id}`;
    const current = selected.get(key);
    if (!current || compare(item, current) < 0) selected.set(key, item);
  }
  return [...selected.values()].sort(compare);
}

// prior is the usage factor of an item (ranking-prior.js): it scales the score,
// the last key, so locality, scope distance and role still decide first.
function compareRecallItems(left, right, prior = NEUTRAL) {
  const leftLocal = left.defined_project_id ? 1 : 0;
  const rightLocal = right.defined_project_id ? 1 : 0;
  if (leftLocal !== rightLocal) return rightLocal - leftLocal;
  const leftDistance = Number(left.scope_distance ?? 0);
  const rightDistance = Number(right.scope_distance ?? 0);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const leftSupporting = knowledgeItemRole(left) === 'supporting' ? 1 : 0;
  const rightSupporting = knowledgeItemRole(right) === 'supporting' ? 1 : 0;
  if (leftSupporting !== rightSupporting) return leftSupporting - rightSupporting;
  return Number(right.score ?? 0) * prior(right) - Number(left.score ?? 0) * prior(left);
}

function compactFact(fact) {
  return compactItem(fact, {
    source_entity: fact.source_entity,
    target_entity: fact.target_entity,
    relationship: fact.relationship,
    fact: boundedText(fact.fact)
  });
}

function compactEntity(entity) {
  return compactItem(entity, {
    name: entity.name,
    type: entity.type,
    summary: boundedText(entity.summary)
  });
}

function compactItem(item, content) {
  return {
    id: item.id,
    space_id: item.space_id ?? item.spaceId,
    scope: item.scope,
    key: item.key ?? null,
    defined_project_id: item.defined_project_id ?? null,
    inherited_from_project_id: item.inherited_from_project_id ?? null,
    scope_distance: item.scope_distance ?? 0,
    confirmation_status: item.confirmation_status ?? null,
    source_uris: item.source_uris ?? [],
    score: item.score ?? null,
    // Kept so the budget can refuse a historical version (knowledge-result-budget.js).
    ...(item.invalid_at ? { invalid_at: item.invalid_at } : {}),
    ...content
  };
}

// Tool parameters and opaque IDs quoted in a prompt (a fallback search call, a
// JSON shape) are not what the user is asking about; they must not take the
// few focus slots from the names that are.
const METADATA_TERM = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][A-Za-z0-9]*(?:Id|ID|Ids)|[a-z0-9]+(?:_[a-z0-9]+)*_ids?|true|false|null)$/u;

function distinctivePromptTerms(prompt) {
  const quoted = [...prompt.matchAll(/[“”"']([^“”"']{2,80})[“”"']/gu)]
    .map((match) => match[1]);
  // A capitalized word inside a sentence is usually a name (a service, a product).
  const names = prompt.match(/(?<=[a-z0-9,;:)]\s+)[A-Z][a-z]{2,}\b/gu) ?? [];
  const productPhrases = prompt.match(
    /\b[A-Z][A-Za-z0-9]*(?:[ \t]+[A-Z][A-Za-z0-9]*){1,5}\b/gu
  ) ?? [];
  const acronyms = prompt.match(/\b[A-Z]{2,}[A-Z0-9]*\b/gu) ?? [];
  const versions = prompt.match(
    /\bv?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b/gu
  ) ?? [];
  const identifiers = prompt.match(
    /\b[A-Za-z][A-Za-z0-9]{0,63}[_./-][A-Za-z0-9_.\/-]{1,127}\b/gu
  ) ?? [];
  const urls = [...prompt.matchAll(/https?:\/\/[^\s<>()]+/gu)]
    .map((match) => safeUrlSearchTerm(match[0]))
    .filter(Boolean);
  return unique([
    ...quoted,
    ...productPhrases,
    ...acronyms,
    ...names,
    ...identifiers,
    ...urls,
    ...versions
  ].filter((term) => !METADATA_TERM.test(term))).slice(0, 4);
}

// A question about several things finds each stored fact only with a short
// query of its own: the Provider keeps an item when a quarter of the query's
// words appear in it, so one long query of every word matches nothing.
const MAX_CLAUSE_QUERIES = 3;
const CLAUSE_WORD_LIMIT = 5;
const CLAUSE_HAN_LIMIT = 16;
// Asking and doing words: they say what to do with a fact, never which one.
const CLAUSE_STOP_WORDS = new Set(('about add adding after also answer because been before bullet bullets could create '
  + 'does entry every existing exporting file folder following from full give have here into just keep know like line list make more '
  + 'most much need new now one only our please reply repo return returns saying short should show some sure tell than that '
  + 'their them then there these they this those three throw update use using what when where which while will with '
  + 'would write your').split(' '));
const CLAUSE_HAN_FILLERS = /请|帮我|帮忙|麻烦|一下|我们|你们|这个|那个|一个|然后|还有|的|了|吗|呢|吧/gu;
// A clause naming a kept fact ("the retry policy we agreed", "who owns it")
// queries first, so a long change request does not spend the slots on its
// other clauses.
const KNOWN_FACT_CUE = /(?:agreed|decided|convention|policy|rule|owns?\b|owner|\breview|the way we|\bour\b|port\b|command|channel|region|约定|规范|规则|负责|端口|地址|命令|渠道|策略|惯例|决定)/iu;

// The task's own words weigh most where it states the task: the clauses of
// its lead paragraph's first line, or of the whole paragraph when that line
// yields none (a heading such as "Fix these:"). A trailing line a script
// appends ("Work only from this checkout") spends no query (rec#88).
function ownClauseQueries(text, { cuedOnly = false } = {}) {
  const [lead = ''] = text.trim().split(/\r?\n[ \t]*\r?\n/u);
  const lines = lead.split(/\r?\n/u).map(line => line.replace(CODE_SPAN, ' ')).filter(line => line.trim());
  const first = clauseQueries(singleLine(lines[0] ?? ''), { cuedOnly });
  return first.length ? first : clauseQueries(singleLine(lines.join(' ')), { cuedOnly });
}

// When some clauses name a kept fact, only they query: the rest of a change
// request ("so tests do not wait") would bring back unrelated items.
// `cuedOnly`: no clause names one, no query.
function clauseQueries(prompt, { cuedOnly = false } = {}) {
  const clauses = prompt.split(/[,;:，；：。!?！？]|\.(?:\s|$)|\b(?:and|or|then)\b/iu);
  const cued = clauses.filter((clause) => KNOWN_FACT_CUE.test(clause));
  return (cued.length || cuedOnly ? cued : clauses)
    .map(clauseQuery)
    .filter(Boolean)
    .slice(0, MAX_CLAUSE_QUERIES);
}

function clauseQuery(clause) {
  const words = unique((clause.toLocaleLowerCase('en-US').match(/[a-z][a-z0-9-]{2,}/gu) ?? [])
    .filter((word) => !CLAUSE_STOP_WORDS.has(word) && !['the', 'who', 'how', 'for', 'are', 'was'].includes(word)))
    .slice(0, CLAUSE_WORD_LIMIT);
  // The Provider matches Chinese by character pairs, so the clause's own
  // characters, without filler, are the query.
  const han = (clause.match(/[\p{Script=Han}]+/gu) ?? []).join('').replace(CLAUSE_HAN_FILLERS, '').slice(0, CLAUSE_HAN_LIMIT);
  const query = [han.length >= 4 ? han : '', words.length >= 2 || han.length >= 4 ? words.join(' ') : ''].filter(Boolean).join(' ');
  return query || null;
}

// A name the person gave (a quoted phrase, a product, a URL, a version, an
// uncommon acronym), not a file path or code identifier.
const CODE_SPAN = /`[^`]*`/gu;
const COMMON_ACRONYMS = new Set(['API', 'CI', 'CLI', 'CODEOWNERS', 'CSS', 'CSV', 'HTML', 'HTTP', 'HTTPS', 'ID', 'ISO', 'JS',
  'JSON', 'NPM', 'PR', 'README', 'SDK', 'SQL', 'TS', 'UI', 'URL', 'UTC', 'YAML']);

// The text before the first blank line, as one line; the whole prompt when
// it has no later paragraph.
function leadParagraph(taskPrompt) {
  const [lead] = taskPrompt.trim().split(/\r?\n[ \t]*\r?\n/u);
  return singleLine(lead).slice(0, 8192);
}

function namedTarget(prompt) {
  const text = prompt.replace(CODE_SPAN, ' ');
  const identifiers = new Set(text.match(/\b[A-Za-z][A-Za-z0-9]{0,63}[_./-][A-Za-z0-9_.\/-]{1,127}\b/gu) ?? []);
  // A quoted heading or snippet ("## Release") is markup, not a name.
  return distinctivePromptTerms(text).some((term) => !identifiers.has(term) && !COMMON_ACRONYMS.has(term)
    && /^[\p{L}\p{N}]/u.test(term));
}

// On unless the person asked for every answer to be checked against the files.
function answersFromConfirmed(application) {
  return application.getRecallPolicy?.().answerFromConfirmed !== false;
}

// Only items a person confirmed; agent_confirmed ones were promoted by repeated use.
function confirmedByPeople(items) {
  return items.length > 0 && items.every((item) => item.confirmation_status === 'confirmed');
}

function filterRecallCandidates(items, focusTerms) {
  const focusTokens = recallFocusTokens(focusTerms);
  if (!focusTokens.length) return items;
  return items.filter((item) =>
    Boolean(item?.defined_project_id) || recallItemMatchesFocus(item, focusTokens));
}

function recallItemMatchesFocus(item, focusTokens) {
  const text = singleLine([
    item?.key,
    item?.source_entity,
    item?.target_entity,
    item?.relationship,
    item?.fact,
    item?.name,
    item?.type,
    item?.summary,
    ...(Array.isArray(item?.source_uris) ? item.source_uris : [])
  ].filter(Boolean).join(' ')).toLocaleLowerCase('en-US');
  return focusTokens.some((token) => text.includes(token));
}

function recallFocusTokens(terms) {
  return unique(terms.flatMap((term) => [
    ...(term.match(/[\p{Script=Han}]{2,}/gu) ?? []),
    ...(term.match(/[A-Za-z][A-Za-z0-9_-]{2,}/gu) ?? [])
  ]).map((term) => term.toLocaleLowerCase('en-US'))
    .filter((term) => !['http', 'https', 'www', 'version'].includes(term)));
}

function safeUrlSearchTerm(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return `${url.hostname}${url.pathname}`.slice(0, 120);
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function singleLine(value) {
  return String(value).replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function boundedText(value) {
  return singleLine(value ?? '').slice(0, MAX_ITEM_TEXT);
}
