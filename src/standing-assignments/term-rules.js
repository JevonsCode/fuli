import { ApplicationError } from '../app/application-error.js';
import { sharedBranch } from '../conversations/continuation-decision.js';
import { identityKey } from '../text/name-identity.js';

// What a term may be (docs/workstreams.md). A term routes every later task
// whose words, folder or branch name it, so one that occurs almost everywhere
// would capture unrelated work: a single Han, kana or Hangul character, under
// three characters otherwise, or a word every request uses. A term an Agent
// adds to a line or its own assignment on its own (source host; a project's
// lead opening a workstream) needs three Han, kana or Hangul characters:
// two such as 性能 or 上线 occur in requests about anything, and no person
// looked at it. The person may still use two; the console says it is short. A branch term,
// `branch:<name>` or `branch:<prefix>/`, names a branch of one line of work;
// a branch everyone shares names none — the same list that keeps a shared
// branch from proving two sessions continue one piece of work
// (continuation-decision.js sharedBranch).

export const BRANCH_PREFIX = 'branch:';

const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;
const COMMON = new Set([
  '页面', '首页', '修改', '问题', '需求', '功能', '优化', '项目', '代码', '测试', '发布', '接口', '按钮', '文档', '样式', '组件',
  'bug', 'fix', 'page', 'pages', 'web', 'app', 'api', 'src', 'lib', 'test', 'tests', 'admin', 'code', 'main', 'docs',
  'feature', 'update', 'home', 'index', 'style', 'ui', 'ux', 'dev', 'build', 'release'
]);

export const isBranchTerm = key => key.startsWith(BRANCH_PREFIX);

/** Whether a branch term's key names this branch: exactly, or every branch under `prefix/`. */
export function branchMatches(termKey, branch) {
  if (!isBranchTerm(termKey) || typeof branch !== 'string' || !branch) return false;
  const name = termKey.slice(BRANCH_PREFIX.length);
  const current = identityKey(branch);
  return name.endsWith('/') ? current.startsWith(name) : current === name;
}

/** Refuses a term that would match nearly every task, saying why in a sentence the caller can show. */
export function assertUsableTerm(term, key = identityKey(term), source = 'user') {
  if (isBranchTerm(key)) {
    const name = key.slice(BRANCH_PREFIX.length);
    if (!name || name === '/' || sharedBranch(name)) throw tooBroad(term, 'a branch everyone shares names no single line');
    return;
  }
  const characters = [...key.replace(/\s+/gu, '')];
  const unspaced = characters.some(char => UNSPACED.test(char));
  if (characters.length < (unspaced && source !== 'host' ? 2 : 3)) {
    throw tooBroad(term, unspaced && characters.length === 2
      ? 'a term an Agent adds needs at least three characters, since two match requests about anything'
      : 'it is too short and would match almost every request');
  }
  if (COMMON.has(key)) throw tooBroad(term, 'almost every request uses this word');
}

function tooBroad(term, why) {
  return new ApplicationError('standing_assignment_term_too_broad', `"${term}" cannot name a kind of work: ${why}. `
    + 'Use a name only this work has, such as the page, campaign or folder name. Nothing was saved.', { status: 422 });
}
