import { el } from './dom.js';
import { consoleRouteUrl } from './console-route.js';

const PROJECT_DISCOVERY_LIMIT = 15;
const PROJECT_DISCOVERY_CONCURRENCY = 4;

export async function discoverPersonalProjectResults({
  getJson,
  personalSpaceId,
  projects,
  query,
  baseline,
  limit = PROJECT_DISCOVERY_LIMIT
}) {
  const baselineIds = searchResultIds(baseline);
  const candidates = (projects ?? []).slice(0, limit);
  const outcomes = [];

  for (let index = 0; index < candidates.length; index += PROJECT_DISCOVERY_CONCURRENCY) {
    const batch = candidates.slice(index, index + PROJECT_DISCOVERY_CONCURRENCY);
    outcomes.push(...await Promise.all(batch.map(async (project) => {
      try {
        const params = new URLSearchParams({
          personalSpaceId,
          personalProjectId: project.project_id,
          q: query,
          limit: '30'
        });
        const result = await getJson(`/api/search?${params}`);
        const added = searchResultItems(result).filter(({ key }) => !baselineIds.has(key));
        if (!added.length) return { status: 'empty', project };
        return {
          status: 'matched',
          project,
          count: added.length,
          score: Math.max(...added.map(({ score }) => score ?? 0))
        };
      } catch {
        return { status: 'failed', project };
      }
    })));
  }

  return {
    matches: outcomes
      .filter(({ status }) => status === 'matched')
      .sort((left, right) =>
        right.score - left.score ||
        right.count - left.count ||
        left.project.profile.name.localeCompare(right.project.profile.name)
      ),
    checked: outcomes.length,
    total: projects?.length ?? 0,
    failed: outcomes.filter(({ status }) => status === 'failed').length
  };
}

export function personalProjectSearchHref({
  personalSpaceId,
  projectId,
  query,
  location = globalThis.location
}) {
  return consoleRouteUrl({
    view: 'personal-projects',
    knowledge: {
      mode: 'graph',
      space: {
        scope: 'personal',
        spaceId: personalSpaceId,
        projectId
      },
      query,
      type: 'all',
      quadrant: 'all',
      profile: 'all',
      status: 'current',
      contexts: []
    }
  }, location);
}

export function renderGraphSearchStatus(container, {
  query,
  checking = false,
  discoveryAttempted = false,
  matches = [],
  checked = 0,
  total = 0,
  failed = 0
}) {
  const title = el('strong', 'graph-search-status-title', `没有检索到“${query}”`);
  const copy = checking
    ? '当前范围没有命中，正在检查其他个人项目…'
    : discoveryAttempted
      ? resultSummary({ matches, checked, total, failed })
      : '当前范围没有找到可定位的内容，可以调整关键词后重试。';
  const children = [
    el('span', 'graph-search-status-kicker', '当前范围未命中'),
    title,
    el('p', 'graph-search-status-copy', copy)
  ];
  if (matches.length) {
    children.push(el('div', 'graph-search-suggestions', null, matches.slice(0, 5).map((match) => {
      const anchor = el('a', 'graph-search-suggestion', null, [
        el('span', '', null, [
          el('strong', '', match.project.profile.name),
          el('small', '', `${match.count} 条候选内容`)
        ]),
        el('b', '', '进入项目搜索 →')
      ]);
      anchor.href = match.href;
      return anchor;
    })));
  }
  container.replaceChildren(...children);
  container.hidden = false;
}

export function clearGraphSearchStatus(container) {
  container.hidden = true;
  container.replaceChildren();
}

function searchResultIds(result) {
  return new Set(searchResultItems(result).map(({ key }) => key));
}

function searchResultItems(result) {
  return [
    ...(result?.entities ?? []).map((item) => ({
      key: `entity:${item.id}`,
      score: item.score
    })),
    ...(result?.facts ?? []).map((item) => ({
      key: `fact:${item.id}`,
      score: item.score
    }))
  ];
}

function resultSummary({ matches, checked, total, failed }) {
  const failure = failed ? `；${failed} 个项目暂时无法检查` : '';
  if (matches.length) {
    return `其他个人项目中有候选内容。当前结果不会混入其他项目，可进入项目查看完整命中${failure}。`;
  }
  if (!total) return '当前没有其他个人项目可继续检查。';
  if (failed === checked) return '其他个人项目暂时无法检查，请稍后重试。';
  if (checked < total) {
    return `已检查前 ${checked} / ${total} 个其他个人项目，也没有发现候选内容${failure}。`;
  }
  return `已检查其他个人项目，也没有发现候选内容${failure}。`;
}
