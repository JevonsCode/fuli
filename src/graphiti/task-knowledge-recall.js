import { createFuliSourceMarker } from './source-marker.js';
import { knowledgeItemRole } from './knowledge-item-role.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';

const MAX_QUERIES = 4;
const MAX_ITEMS_PER_KIND = 3;
const MAX_ITEM_TEXT = 1000;

const RECALL_INTENTS = Object.freeze([
  {
    category: 'release_delivery',
    pattern: /(?:发布|发版|上线|部署|推送|再推|release|publish|push|deploy|ship|rollout|commit|github|\bgit\b)/iu,
    queries: [
      '发布 发版 版本 release publish runbook',
      '推送 提交 push commit GitHub Connector runbook'
    ]
  },
  {
    category: 'access_authentication',
    pattern: /(?:认证|登录|凭据|身份|令牌|密钥|credential|authentication|authorization|login|token|ssh)/iu,
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
    category: 'prior_context',
    pattern: /(?:之前|以前|上次|已经存|保存过|记得|照旧|同样|还是用|不用再|先前|previous|earlier|remember|same as|again)/iu,
    queries: ['先前 方法 规则 决策 runbook previous method decision']
  }
]);

export const TASK_KNOWLEDGE_RETRIEVAL_GUIDANCE = Object.freeze({
  before_reasking:
    'Before asking the user to repeat a stable project fact or method, inspect task_knowledge_recall and search Fuli when needed.',
  focused_queries:
    'Use one to four focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query.',
  scope:
    'Search only the exact active personal project, its explicitly inheritable knowledge, and the bounded personal-global profile.',
  candidate_selection:
    'Treat automatic matches as candidates. Cite only items that materially support the task; if all are irrelevant, use noMatchSourceMarker.'
});

export function planTaskKnowledgeRecall(taskPrompt) {
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim()) {
    return { status: 'not_requested', trigger_categories: [], queries: [] };
  }
  const prompt = singleLine(taskPrompt).slice(0, 8192);
  if (detectSensitiveContent(prompt).restricted) {
    return {
      status: 'suppressed_sensitive',
      trigger_categories: [],
      queries: []
    };
  }
  const matched = RECALL_INTENTS.filter(({ pattern }) => pattern.test(prompt));
  if (!matched.length) {
    return { status: 'not_needed', trigger_categories: [], queries: [] };
  }
  const focus = distinctivePromptTerms(prompt).join(' ').slice(0, 180);
  const queries = unique(matched.flatMap(({ queries: values }) => values)
    .map((query) => focus ? `${focus} ${query}` : query));
  return {
    status: 'planned',
    trigger_categories: matched.map(({ category }) => category),
    queries: unique(queries).slice(0, MAX_QUERIES)
  };
}

export async function recallTaskKnowledge(application, resolution, taskPrompt) {
  const plan = planTaskKnowledgeRecall(taskPrompt);
  if (plan.status !== 'planned') return recallWithoutSearch(plan.status, plan);
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
      includePending: false,
      agentInvocation: true,
      agentToolName: 'automatic_task_knowledge_recall'
    })
  ));
  const results = settlements
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => value);
  const failedQueryCount = settlements.length - results.length;
  const focusTerms = distinctivePromptTerms(singleLine(taskPrompt).slice(0, 8192));
  const facts = rankedUnique(
    filterRecallCandidates(
      results.flatMap(({ facts = [] }) => facts),
      focusTerms
    ),
    'relationship'
  ).slice(0, MAX_ITEMS_PER_KIND).map(compactFact);
  const entities = rankedUnique(
    filterRecallCandidates(
      results.flatMap(({ entities = [] }) => entities),
      focusTerms
    ),
    'entity'
  ).slice(0, MAX_ITEMS_PER_KIND).map(compactEntity);
  const sourceMarker = createFuliSourceMarker({
    consoleUrl: application.consoleUrl,
    facts,
    entities,
    projectScopePriority: 'strict'
  });
  const searched = results.length > 0;
  return {
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
    facts,
    entities
  };
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

function rankedUnique(items, itemKind) {
  const selected = new Map();
  for (const item of items) {
    const key = `${itemKind}:${item.id}`;
    const current = selected.get(key);
    if (!current || compareRecallItems(item, current) < 0) selected.set(key, item);
  }
  return [...selected.values()].sort(compareRecallItems);
}

function compareRecallItems(left, right) {
  const leftLocal = left.defined_project_id ? 1 : 0;
  const rightLocal = right.defined_project_id ? 1 : 0;
  if (leftLocal !== rightLocal) return rightLocal - leftLocal;
  const leftDistance = Number(left.scope_distance ?? 0);
  const rightDistance = Number(right.scope_distance ?? 0);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const leftSupporting = knowledgeItemRole(left) === 'supporting' ? 1 : 0;
  const rightSupporting = knowledgeItemRole(right) === 'supporting' ? 1 : 0;
  if (leftSupporting !== rightSupporting) return leftSupporting - rightSupporting;
  return Number(right.score ?? 0) - Number(left.score ?? 0);
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
    ...content
  };
}

function distinctivePromptTerms(prompt) {
  const quoted = [...prompt.matchAll(/[“”"']([^“”"']{2,80})[“”"']/gu)]
    .map((match) => match[1]);
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
    ...identifiers,
    ...urls,
    ...versions
  ]).slice(0, 4);
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
