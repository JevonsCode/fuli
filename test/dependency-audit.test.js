import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bundledPackagesFile, bundledPackagesPlugin } from '../scripts/bundled-packages.js';

// Plan item 16: a pull request fails only on advisories in what ships to users;
// the whole tree is audited daily and gets a fix pull request or an issue.
const GATE = fileURLToPath(new URL('../scripts/audit-shipped.js', import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ci = read('.github/workflows/ci.yml');
const daily = read('.github/workflows/dependency-audit.yml');

// A synthetic install: `rt` is a runtime dependency, `vue` a devDependency the
// console bundles, `tool` a test tool with its own nested copy of `rt`.
function fixture(t, { bundled = ['node_modules/vue'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-dependency-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'npm-shrinkwrap.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { rt: '^1.0.0' }, devDependencies: { vue: '^3.0.0', tool: '^1.0.0' } },
      'node_modules/rt': { version: '1.0.0' },
      'node_modules/vue': { version: '3.0.0', dev: true },
      'node_modules/tool': { version: '1.0.0', dev: true, dependencies: { rt: '^0.1.0', glob: '^1.0.0' } },
      'node_modules/tool/node_modules/rt': { version: '0.1.0', dev: true },
      'node_modules/glob': { version: '1.0.0', dev: true }
    }
  }));
  if (bundled) {
    mkdirSync(join(root, 'dist'));
    writeFileSync(bundledPackagesFile(root), JSON.stringify(bundled));
  }
  return root;
}

function gate(root, report) {
  const path = join(root, 'report.json');
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [GATE, path, '--root', root], { encoding: 'utf8' });
}

const advisory = (name, nodes, severity = 'moderate') => ({
  name, severity, range: '<9.9.9', nodes,
  via: [{ title: `Synthetic ${name} advisory`, url: `https://example.invalid/${name}` }]
});

test('an advisory only in a test tool is reported but does not fail the gate', (t) => {
  const root = fixture(t);
  const result = gate(root, { vulnerabilities: {
    glob: advisory('glob', ['node_modules/glob'], 'high'),
    rt: advisory('rt', ['node_modules/tool/node_modules/rt'])
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /only in development tools/);
  assert.match(result.stdout, /glob <9\.9\.9 \(high\): Synthetic glob advisory https:\/\/example\.invalid\/glob/);
  assert.match(result.stdout, /\brt <9\.9\.9/, 'the nested dev-only copy of a runtime package does not ship');
});

test('an advisory in a runtime dependency or a bundled package fails the gate', (t) => {
  const root = fixture(t);
  for (const [name, node] of [['rt', 'node_modules/rt'], ['vue', 'node_modules/vue']]) {
    const result = gate(root, { vulnerabilities: { [name]: advisory(name, [node], 'low') } });
    assert.equal(result.status, 1, `${name} ships`);
    assert.match(result.stderr, new RegExp(`what ships to users[\\s\\S]*${name} <9\\.9\\.9 \\(low\\)`));
  }
  const info = gate(root, { vulnerabilities: { rt: advisory('rt', ['node_modules/rt'], 'info') } });
  assert.equal(info.status, 0, 'informational entries never block, as with --audit-level=low');
  assert.match(info.stdout, /No advisories\./);
});

test('the gate refuses a failed audit or a missing bundle record instead of passing', (t) => {
  const failed = gate(fixture(t), { error: { code: 'ENOTFOUND', summary: 'request to the registry failed' } });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /npm audit did not produce a report[\s\S]*ENOTFOUND/);

  const unbuilt = gate(fixture(t, { bundled: null }), { vulnerabilities: {} });
  assert.equal(unbuilt.status, 2);
  assert.match(unbuilt.stderr, /run `npm run build:web` first/);
});

test('the build records the lockfile path of every package in the console bundle', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-bundled-packages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = bundledPackagesPlugin(root);
  assert.equal(plugin.apply, 'build');
  plugin.generateBundle({}, {
    'index.js': { type: 'chunk', moduleIds: [
      join(root, 'node_modules', 'vue', 'dist', 'vue.runtime.esm-bundler.js'),
      `${join(root, 'node_modules', '@scope', 'lib', 'node_modules', 'inner', 'index.js')}?vue&type=script`,
      join(root, 'node_modules', 'vue', 'index.js'),
      '\0plugin-vue:export-helper',
      join(root, 'web', 'src', 'main.ts')
    ] },
    'index.css': { type: 'asset' }
  });
  assert.deepEqual(JSON.parse(readFileSync(bundledPackagesFile(root), 'utf8')),
    ['node_modules/@scope/lib/node_modules/inner', 'node_modules/vue']);
  assert.match(read('vite.config.ts'), /plugins: \[[^\]]*bundledPackagesPlugin\(/);
});

test('pull request CI blocks only on what ships, after the build that records the bundle', () => {
  assert.doesNotMatch(ci, /npm@[\d.]+ audit --audit-level/, 'no whole-tree audit blocks a pull request');
  const node = ci.slice(ci.indexOf('\n  node:'), ci.indexOf('\n  provider:'));
  const audit = node.indexOf('node scripts/audit-shipped.js "$RUNNER_TEMP/npm-audit.json"');
  assert.ok(audit > node.indexOf('npx --yes npm@11.13.0 audit --json > "$RUNNER_TEMP/npm-audit.json" || true'));
  assert.ok(audit > node.indexOf('- run: npm test'), 'npm test builds the console first');
  assert.match(ci, /\n {2}workflow_dispatch:\n/, 'the daily audit can start CI on its fix branch');
});

test('the daily audit covers the whole tree and opens one fix pull request or one issue', () => {
  assert.match(daily, /\non:\n {2}schedule:\n {4}- cron: "[^"]+"\n {2}workflow_dispatch:\n/);
  assert.match(daily, /\npermissions:\n {2}contents: read\n/);
  const job = daily.slice(daily.indexOf('\n  audit:'));
  assert.match(job, / {4}permissions:\n {6}contents: write[^\n]*\n {6}pull-requests: write[^\n]*\n {6}issues: write[^\n]*\n {6}actions: write[^\n]*\n {4}env:/);
  assert.equal(daily.match(/NPM_CLI: npm@(\d+\.\d+\.\d+)/)[1], ci.match(/npm@(\d+\.\d+\.\d+)/)[1], 'the same npm CLI pin as CI');
  assert.equal(daily.match(/npm@\d/g).length, 1, 'pinned once');
  assert.doesNotMatch(daily, /--omit=dev|audit fix[^\n]*--force/, 'the whole tree, and no breaking fixes');
  assert.match(daily, /"\$NPM_CLI" audit fix --package-lock-only \|\| true/);
  assert.match(daily, /gh workflow run ci\.yml --ref "\$FIX_BRANCH"/);
  assert.match(daily, /gh pr create --base main --head "\$FIX_BRANCH"/);
  assert.match(daily, /echo "blocked=true"/, 'a refused pull request falls back to the issue');
  assert.match(daily, /gh issue create --title "\$ISSUE_TITLE"/);
  assert.match(daily, /gh issue close "\$issue"/);
});
