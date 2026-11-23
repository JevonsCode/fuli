import { ApplicationError } from '../app/application-error.js';
import { identityKey } from '../text/name-identity.js';

// What a term may be (docs/workstreams.md). A term routes every later task
// whose words, folder or branch name it, so one that occurs almost everywhere
// would capture unrelated work: a single Han, kana or Hangul character, under
// three characters otherwise, or a word every request uses. A branch term,
// `branch:<name>` or `branch:<prefix>/`, names a branch of one line of work;
// a branch everyone shares (main, develop, release/…) names none.

export const BRANCH_PREFIX = 'branch:';

const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;
const COMMON = new Set([
  '页面', '首页', '修改', '问题', '需求', '功能', '优化', '项目', '代码', '测试', '发布', '接口', '按钮', '文档', '样式', '组件',
  'bug', 'fix', 'page', 'pages', 'web', 'app', 'api', 'src', 'lib', 'test', 'tests', 'admin', 'code', 'main', 'docs',
  'feature', 'update', 'home', 'index', 'style', 'ui', 'ux', 'dev', 'build', 'release'
]);
const SHARED_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'development', 'dev', 'release', 'staging',
  'stage', 'production', 'prod', 'test', 'testing', 'qa', 'gh-pages', 'head']);
const SHARED_BRANCH_PREFIXES = ['release/', 'hotfix/', 'releases/'];

export const isBranchTerm = key => key.startsWith(BRANCH_PREFIX);

/** True for a branch several lines of work share: never a line's branch. */
export function isSharedBranch(name) {
  const key = identityKey(name);
  return SHARED_BRANCHES.has(key) || SHARED_BRANCH_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** The branch term for a branch, or null for a shared one. */
export function branchTerm(name) {
  if (typeof name !== 'string' || !name.trim() || isSharedBranch(name)) return null;
  return `${BRANCH_PREFIX}${name.trim()}`;
}

/** Whether a branch term's key names this branch: exactly, or every branch under `prefix/`. */
export function branchMatches(termKey, branch) {
  if (!isBranchTerm(termKey) || typeof branch !== 'string' || !branch) return false;
  const name = termKey.slice(BRANCH_PREFIX.length);
  const current = identityKey(branch);
  return name.endsWith('/') ? current.startsWith(name) : current === name;
}

/** Refuses a term that would match nearly every task, saying why in a sentence the caller can show. */
export function assertUsableTerm(term, key = identityKey(term)) {
  if (isBranchTerm(key)) {
    const name = key.slice(BRANCH_PREFIX.length);
    if (!name || name === '/' || isSharedBranch(name)) throw tooBroad(term, 'a branch everyone shares names no single line');
    return;
  }
  const characters = [...key.replace(/\s+/gu, '')];
  const short = characters.some(char => UNSPACED.test(char)) ? characters.length < 2 : characters.length < 3;
  if (short) throw tooBroad(term, 'it is too short and would match almost every request');
  if (COMMON.has(key)) throw tooBroad(term, 'almost every request uses this word');
}

function tooBroad(term, why) {
  return new ApplicationError('standing_assignment_term_too_broad', `"${term}" cannot name a kind of work: ${why}. `
    + 'Use a name only this work has, such as the page, campaign or folder name. Nothing was saved.', { status: 422 });
}
