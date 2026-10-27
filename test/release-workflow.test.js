import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8'
);

test('release uses the same verified npm CLI pin as CI', () => {
  const ciPins = npmPins(ciWorkflow);
  const releasePins = npmPins(releaseWorkflow);

  assert.equal(ciPins.length, 1);
  assert.equal(releasePins.length, 2);
  assert.deepEqual([...new Set(releasePins)], ciPins);
});

test('release validates the tag before publishing the package', () => {
  const tagCheck = releaseWorkflow.indexOf('Verify release tag matches package version');
  const publish = releaseWorkflow.indexOf('publish --access public');

  assert.ok(tagCheck >= 0);
  assert.ok(publish > tagCheck);
  assert.match(releaseWorkflow, /GITHUB_REF_NAME.*\('v'\+p\.version\)/);
});

test('release publishes prereleases without moving the stable latest dist-tag', () => {
  const distTag = releaseWorkflow.indexOf('Resolve npm dist-tag');
  const publish = releaseWorkflow.indexOf('publish --access public');

  assert.ok(distTag >= 0);
  assert.ok(publish > distTag);
  assert.match(releaseWorkflow, /const tag=prerelease\?prerelease\.split\('\.'\)\[0\]:'latest'/);
  assert.match(releaseWorkflow, /publish --access public --tag "\$\{\{ steps\.npm-dist-tag\.outputs\.tag \}\}"/);
});

test('release attaches the Windows tray package the one-click update downloads, after npm publishes', () => {
  const job = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  windows-tray:'));
  assert.ok(releaseWorkflow.indexOf('publish --access public') < releaseWorkflow.indexOf('\n  windows-tray:'));
  assert.match(job, /needs: publish/);
  assert.match(job, /permissions:\n {6}contents: write/);
  assert.match(job, /scripts\/package-windows-tray-release\.js/);
  assert.match(job, /gh release upload "\$env:GITHUB_REF_NAME"/);
  assert.match(job, /NATIVE_NEO4J_SHA256/, 'the bundled Neo4j is the pinned, checksum-verified archive');
});

function npmPins(workflow) {
  return [...workflow.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}
