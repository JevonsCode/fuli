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

function npmPins(workflow) {
  return [...workflow.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}
