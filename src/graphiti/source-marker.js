import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { DEFAULT_FULI_PORT } from '../defaults.js';

const MAX_CITATIONS = 1;
const DEFAULT_CONSOLE_URL = `http://127.0.0.1:${DEFAULT_FULI_PORT}`;

export function sourceConsoleUrl(runtimeConfigPath, {
  readText = (path) => readFileSync(path, 'utf8')
} = {}) {
  if (!runtimeConfigPath) return DEFAULT_CONSOLE_URL;
  try {
    const statePath = join(dirname(resolve(runtimeConfigPath)), 'graph-runtime-state.json');
    const state = JSON.parse(readText(statePath));
    return safeLoopbackOrigin(state?.url) ?? DEFAULT_CONSOLE_URL;
  } catch {
    return DEFAULT_CONSOLE_URL;
  }
}

export function createFuliSourceMarker({
  consoleUrl = DEFAULT_CONSOLE_URL,
  facts = [],
  entities = []
} = {}) {
  const citations = uniqueCitations([
    ...facts.map(factCitation),
    ...entities.map(entityCitation)
  ].filter(Boolean));
  const status = citations.length ? 'matched' : 'no_match';
  return {
    required: true,
    label: 'FULI 来源',
    status,
    count: citations.length,
    leadMarkdown: sourceLeadMarkdown({ consoleUrl, citations }),
    markdown: sourceMarkerMarkdown({ consoleUrl, citations })
  };
}

function factCitation(fact) {
  return citation({
    scope: fact.scope,
    spaceId: fact.spaceId ?? fact.space_id,
    itemKind: 'relationship',
    itemId: fact.id,
    title: [fact.source_entity, fact.target_entity].filter(Boolean).join(' → ') ||
      fact.fact || '关系知识'
  });
}

function entityCitation(entity) {
  return citation({
    scope: entity.scope,
    spaceId: entity.spaceId ?? entity.space_id,
    itemKind: 'entity',
    itemId: entity.id,
    title: entity.name || entity.summary || '实体知识'
  });
}

function citation({ scope, spaceId, itemKind, itemId, title }) {
  if (!['personal', 'project'].includes(scope) || !spaceId || !itemId) return null;
  return {
    scope,
    spaceId: String(spaceId),
    itemKind,
    itemId: String(itemId),
    title: singleLine(title)
  };
}

function uniqueCitations(citations) {
  const seen = new Set();
  return citations.filter(({ scope, spaceId, itemKind, itemId }) => {
    const key = `${scope}:${spaceId}:${itemKind}:${itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceLeadMarkdown({ consoleUrl, citations }) {
  if (!citations.length) {
    const origin = safeLoopbackOrigin(consoleUrl) ?? DEFAULT_CONSOLE_URL;
    return `**[◇ FULI · 已检索，未命中](${origin}/)**`;
  }
  return `**[🌠 FULI · 知识增强](${knowledgeUrl(consoleUrl, citations[0])})**`;
}

function sourceMarkerMarkdown({ consoleUrl, citations }) {
  if (!citations.length) {
    return [
      '**FULI 来源 · 未命中**',
      '',
      `- [打开 Fuli](${safeLoopbackOrigin(consoleUrl) ?? DEFAULT_CONSOLE_URL}/)`
    ].join('\n');
  }
  const shown = citations.slice(0, MAX_CITATIONS);
  const hidden = citations.length - shown.length;
  return [
    `**FULI 来源 · ${citations.length} 条**`,
    '',
    ...shown.map((item) =>
      `- [${markdownLabel(item.title)}](${knowledgeUrl(consoleUrl, item)})`
    ),
    ...(hidden ? [`- 另有 ${hidden} 条命中，可在 Fuli 中查看`] : [])
  ].join('\n');
}

function knowledgeUrl(consoleUrl, { scope, spaceId, itemKind, itemId }) {
  const origin = safeLoopbackOrigin(consoleUrl) ?? DEFAULT_CONSOLE_URL;
  const segments = ['knowledge', scope, spaceId, itemKind, itemId]
    .map((segment) => encodeURIComponent(segment));
  return `${origin}/#/${segments.join('/')}`;
}

function safeLoopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return null;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function singleLine(value) {
  return String(value ?? '知识记录').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) ||
    '知识记录';
}

function markdownLabel(value) {
  return singleLine(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\[\]])/g, '\\$1');
}
