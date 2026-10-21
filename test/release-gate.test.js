import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const GATE = fileURLToPath(new URL('../scripts/release-gate.js', import.meta.url));

test('data format migration part 2 opened the gate; any other marker still blocks (rec#17 D-11)', (t) => {
  const committed = JSON.parse(readFileSync(new URL('../release-gate.json', import.meta.url), 'utf8'));
  assert.equal(committed.formatReleaseGate, 'open');
  assert.match(committed.reason, /publishing a beta is still a separate human decision/);
  assert.equal(spawnSync(process.execPath, [GATE], { encoding: 'utf8' }).status, 0);

  const directory = mkdtempSync(join(tmpdir(), 'fuli-release-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blockedMarker = join(directory, 'release-gate.json');
  writeFileSync(blockedMarker, JSON.stringify({ formatReleaseGate: 'blocked-until-part-2', reason: 'synthetic' }));
  const blocked = spawnSync(process.execPath, [GATE, blockedMarker], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Release blocked: formatReleaseGate is "blocked-until-part-2"/);
});

test('every publish path runs the gate first', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('node scripts/release-gate.js') > 0);
  assert.ok(workflow.indexOf('node scripts/release-gate.js') < workflow.indexOf(' publish --access public'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(manifest.scripts.prepublishOnly, /^node scripts\/release-gate\.js && /);
});
