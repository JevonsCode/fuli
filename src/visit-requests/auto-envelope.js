import { detectSensitiveContent } from '../security/sensitive-content.js';

// The rule a requester in mode auto runs under (auto_envelope_v1). It decides
// from facts FULI checks itself: the budget, the plan's declared fields (only
// to keep a request back, never to let one through on its own), and after the
// run the actual diff of the request's branch. What a model said can only make
// the outcome stricter: a plan that declares nothing risky still meets the
// diff check, and a diff that fails it is held whatever the plan said.
export const AUTO_ENVELOPE_RULE = 'auto_envelope_v1';
const MAX_CHANGED_LINES = 400;
const MAX_CHANGED_FILES = 20;

// Package manifests and lockfiles of the ecosystems FULI meets, build and
// tool files that run code when the owner opens, builds or tests the branch
// (editor, container and Agent settings, build scripts and wrappers, test
// hooks), CI, env files, Git's own files, config folders and anything that
// runs as a program.
const DENIED_NAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'bun.lockb', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'pyproject.toml', 'poetry.lock',
  'pipfile', 'pipfile.lock', 'setup.py', 'setup.cfg', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'pom.xml', 'packages.lock.json', 'podfile', 'podfile.lock', '.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml',
  'jenkinsfile', 'makefile', 'justfile', 'rakefile', 'flake.nix', '.pre-commit-config.yaml', 'lefthook.yml', '.mcp.json',
  'claude.md', 'agents.md', 'gemini.md', '.npmrc', '.pnpmfile.cjs', '.envrc', 'conftest.py', 'build.rs', 'cmakelists.txt',
  'pytest.ini', 'tox.ini', 'noxfile.py', 'sitecustomize.py', 'usercustomize.py']);
const DENIED_DIRECTORIES = new Set(['.github', '.circleci', '.gitlab', '.husky', 'config', '.git', '.vscode', '.idea',
  '.devcontainer', '.claude', '.cursor', '.mvn', '.cargo']);
const DENIED_PATTERNS = [/^requirements.*\.txt$/, /(?:^|\.)env(?:\.|$)/, /^\.yarnrc/, /\.csproj$/, /\.sln$/,
  /^directory\.build\./, /^directory\.packages\.props$/, /^settings\.gradle/, /^build\.gradle/, /^gradlew/, /^mvnw/,
  /\.config\.(?:js|cjs|mjs|ts|mts|cts)$/, /\.gemspec$/, /^dockerfile/, /^docker-compose/, /^\.eslintrc\.c?js$/, /^\.babelrc\.js$/,
  /^\.prettierrc\.c?js$/, /\.targets$/, /\.props$/, /^gulpfile\./, /^gruntfile\./, /\.cmake$/, /\.pth$/,
  /\.(?:exe|dll|so|dylib|sh|bash|zsh|bat|cmd|ps1|psm1|com|msi|app|jar|bin)$/];
// Folders denied where they start (gradle/wrapper sits inside gradle/).
const DENIED_PREFIXES = ['gradle/wrapper/'];

// Before the run: the budget is left and the lead's plan keeps to files under
// the project, with no dependency, configuration or network change. Answers
// { ok, checks: [{ name, ok }] }; a missing plan fails.
export function preRunCheck({ plan, budgetLeft }) {
  const checks = [
    { name: 'budget_left', ok: budgetLeft },
    { name: 'plan_ready', ok: Boolean(plan) },
    { name: 'areas_inside_project', ok: Boolean(plan) && plan.areas.length > 0 && plan.areas.every(insideProject) },
    { name: 'no_dependency_changes', ok: plan?.dependencyChanges === false },
    { name: 'no_config_changes', ok: plan?.configChanges === false },
    { name: 'no_network', ok: plan?.network === false }
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

// After the run, over the branch's actual changes (worktree.js branchChanges):
// every path inside the worktree and outside the deny list, no executable or
// binary file, at most MAX_CHANGED_LINES lines in MAX_CHANGED_FILES files, and
// no secret in what was added.
// platform: on Windows Git records no file modes, so any file without an
// extension (a script that is executable elsewhere) is denied too.
export function postRunCheck({ files, addedText, platform = process.platform }) {
  const lines = files.reduce((sum, file) => sum + (file.added ?? 0) + (file.removed ?? 0), 0);
  const checks = [
    { name: 'paths_inside_worktree', ok: files.every((file) => insideProject(file.path)) },
    { name: 'no_denied_paths', ok: !files.some((file) => deniedPath(file.path, platform)) },
    { name: 'no_executables', ok: !files.some((file) => file.executable || file.binary || file.symlink) },
    { name: 'within_size', ok: files.length <= MAX_CHANGED_FILES && lines <= MAX_CHANGED_LINES },
    secretCheck(addedText)
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

// Runs for every request whatever its mode: nothing that looks like a secret
// leaves this computer in a summary or reaches the owner's branch unflagged.
export function secretCheck(text) {
  return { name: 'no_secrets', ok: !detectSensitiveContent(text).restricted };
}

// A path relative to the project, never climbing out of it.
function insideProject(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return false;
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

function deniedPath(path, platform) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/');
  const name = segments.at(-1);
  return DENIED_NAMES.has(name) || name.startsWith('.git') || DENIED_PATTERNS.some((pattern) => pattern.test(name))
    || DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix) || normalized.includes(`/${prefix}`))
    || segments.slice(0, -1).some((segment) => DENIED_DIRECTORIES.has(segment))
    || (platform === 'win32' && !name.includes('.'));
}
