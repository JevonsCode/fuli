import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SpaceKind } from '../src/models.js';
import { observeGitDiff, parseGitDiff } from '../src/observer.js';
import { FileStore } from '../src/store.js';

test('observes git diff as lightweight growth input', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-observer-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fuli@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Fuli Test'], { cwd });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd });

  const docPath = join(cwd, 'project.md');
  writeFileSync(docPath, '# Project A\n', 'utf8');
  execFileSync('git', ['add', 'project.md'], { cwd });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd, stdio: 'ignore' });
  writeFileSync(
    docPath,
    [
      '# Project A',
      'test_url: https://test.example.com',
      '可能这个模块以后要拆出去'
    ].join('\n'),
    'utf8'
  );

  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  const result = observeGitDiff({
    store,
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    cwd
  });

  assert.equal(result.observed.length, 2);
  assert.deepEqual(
    store.currentFacts(project.id).map((fact) => fact.object),
    ['https://test.example.com']
  );
  assert.equal(store.pendingCandidates(personal.id).length, 1);
  assert.equal(store.pendingCandidates(personal.id)[0].targetSpaceId, project.id);
  assert.equal(
    store.data.episodes.some(
      (episode) => episode.sourceUri === 'git-diff:project.md' && episode.body.includes('test_url')
    ),
    true
  );
});

test('observes git diff into the only subscribed project when no target is selected', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-observer-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fuli@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Fuli Test'], { cwd });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd });

  const docPath = join(cwd, 'env.md');
  writeFileSync(docPath, '# Env\n', 'utf8');
  execFileSync('git', ['add', 'env.md'], { cwd });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd, stdio: 'ignore' });
  writeFileSync(docPath, '# Env\ntest_url: https://implicit.example.com\n', 'utf8');

  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);
  store.subscribe(personal.id, project.id);

  observeGitDiff({
    store,
    personalSpaceId: personal.id,
    cwd
  });

  assert.deepEqual(
    store.currentFacts(project.id).map((fact) => fact.object),
    ['https://implicit.example.com']
  );
  assert.equal(store.pendingCandidates(personal.id).length, 0);
});

test('observes natural forbidden rules from git diff', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fuli-observer-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fuli@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Fuli Test'], { cwd });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd });

  const docPath = join(cwd, 'rules.md');
  writeFileSync(docPath, '# Rules\n', 'utf8');
  execFileSync('git', ['add', 'rules.md'], { cwd });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd, stdio: 'ignore' });
  writeFileSync(docPath, '# Rules\n这个项目不要用 Redux\n', 'utf8');

  const store = new FileStore(':memory:');
  const personal = store.createSpace('Jevons', SpaceKind.PERSONAL);
  const project = store.createSpace('Project A', SpaceKind.PUBLIC);

  const result = observeGitDiff({
    store,
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    cwd
  });

  assert.equal(result.observed.length, 1);
  assert.deepEqual(
    store.currentFacts(project.id).map((fact) => [fact.predicate, fact.object]),
    [['forbids', 'Redux']]
  );
});

test('git diff parsing skips ordinary code lines to keep observation quiet', () => {
  const episodes = parseGitDiff(`
diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -0,0 +1,6 @@
+const retries = 3;
+function startServer() {}
+test_url: https://quiet.example.com
+测试账号：demo
+// 可能这个模块以后要拆出去
+这个项目不要用 Redux
`);

  assert.deepEqual(
    episodes.map((episode) => episode.body),
    [
      'test_url: https://quiet.example.com',
      '测试账号：demo',
      '// 可能这个模块以后要拆出去',
      '这个项目不要用 Redux'
    ]
  );
});
