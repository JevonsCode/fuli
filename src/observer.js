import { execFileSync } from 'node:child_process';

import { IngestionService } from './ingestion.js';

const CONTEXT_MARKERS = ['可能', '也许', '不确定', '待确认', '以后要', '似乎'];
const URL_PATTERN = /https?:\/\//;
const KEY_VALUE_PATTERN = /^[\p{L}\p{N}_.-]+\s*[:：]\s*\S/u;
const FORBIDDEN_RULE_PATTERN =
  /^(?:这个项目|本项目|项目)?\s*(?:禁止|不要|不允许)\s*(?:使用|采用|引入|用)?\s*\S+/;

export function observeGitDiff({ store, personalSpaceId, targetSpaceId = null, cwd = process.cwd() }) {
  const service = new IngestionService(store);
  const resolvedTargetSpaceId = targetSpaceId ?? inferOnlySubscribedSpace(store, personalSpaceId);
  const observed = collectGitDiffEpisodes({ cwd }).map((episode) => ({
    ...episode,
    result: service.remember({
      personalSpaceId,
      targetSpaceId: resolvedTargetSpaceId,
      sourceKind: 'git',
      body: episode.body,
      sourceUri: episode.sourceUri
    })
  }));

  return { observed };
}

function inferOnlySubscribedSpace(store, personalSpaceId) {
  const subscriptions = store.subscriptionsFor(personalSpaceId);
  return subscriptions.length === 1 ? subscriptions[0].spaceId : null;
}

export function collectGitDiffEpisodes({ cwd = process.cwd(), maxBuffer = 1024 * 1024 } = {}) {
  const diff = execFileSync('git', ['diff', '--unified=0', '--no-ext-diff'], {
    cwd,
    encoding: 'utf8',
    maxBuffer
  });
  return parseGitDiff(diff);
}

export function parseGitDiff(diff) {
  const episodes = [];
  let currentPath = null;

  for (const rawLine of diff.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      currentPath = rawLine.slice('+++ b/'.length);
      continue;
    }

    if (rawLine.startsWith('+++ ')) {
      currentPath = null;
      continue;
    }

    if (!rawLine.startsWith('+')) continue;

    const body = rawLine.slice(1).trim();
    if (!body) continue;
    if (!isContextWorthyLine(body)) continue;

    episodes.push({
      body,
      sourceUri: `git-diff:${currentPath ?? 'unknown'}`
    });
  }

  return episodes;
}

function isContextWorthyLine(body) {
  return (
    KEY_VALUE_PATTERN.test(body) ||
    URL_PATTERN.test(body) ||
    body.startsWith('替代:') ||
    body.startsWith('替代：') ||
    body.startsWith('禁止:') ||
    body.startsWith('禁止：') ||
    FORBIDDEN_RULE_PATTERN.test(body) ||
    CONTEXT_MARKERS.some((marker) => body.includes(marker))
  );
}
