import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createSitePages } from '../scripts/build-site.js';
import { publishedStable, readReleases, stableInstallers } from '../scripts/site-published-release.js';

// 11-19: after the 0.27.17 release PR merged, Pages linked the stable downloads to
// a draft v0.27.17 and anonymous Windows downloads answered 404. The stable pages
// now follow the newest public, complete stable release. Synthetic release lists.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const templates = { home: read('../site/index.html'), preview: read('../site/next/index.html'), models: read('../site/models/index.html'),
  tech: read('../site/tech/index.html'), guide: read('../site/guide/index.html'), report: read('../site/report/index.html') };
const release = (version, { draft = false, prerelease = version.includes('-'), assets = stableInstallers(version) } = {}) =>
  ({ tag_name: `v${version}`, draft, prerelease, assets: assets.map(name => ({ name })) });
const download = version => [`https://github.com/JevonsCode/fuli/releases/download/v${version}/FULI-Setup-${version}.exe`,
  `https://github.com/JevonsCode/fuli/releases/download/v${version}/fuli-macos-arm64-${version}.dmg`];
const links = (files, path) => {
  const { document } = parseHTML(files.get(path));
  return [document.querySelector('[data-download-windows]').href, document.querySelector('[data-download-macos]').href];
};

test('a draft, a beta, or a release still missing an installer never replaces the last complete stable one', () => {
  const shipped = release('0.27.16');
  assert.equal(publishedStable([release('0.27.17', { draft: true }), shipped, release('0.29.0-beta.8')], '0.27.17'), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { assets: ['FULI-Setup-0.27.17.exe'] }), shipped], '0.27.17'), '0.27.16',
    'Windows alone is not enough');
  assert.equal(publishedStable([release('0.27.17', { assets: ['fuli-macos-arm64-0.27.17.dmg'] }), shipped], '0.27.17'), '0.27.16',
    'macOS alone is not enough');
  assert.equal(publishedStable([release('0.27.17', { prerelease: true }), shipped], '0.27.17'), '0.27.16', 'marked prerelease');
  assert.equal(publishedStable([release('0.27.18'), shipped], '0.27.17'), '0.27.16', 'never newer than the build');
  assert.equal(publishedStable([release('0.27.17', { draft: true })], '0.27.17'), null);
  // Public with both installers: the site switches to it.
  assert.equal(publishedStable([release('0.27.17'), shipped], '0.27.17'), '0.27.17');
});

test('while 0.27.17 is a draft the stable pages, in every language, name and download 0.27.16', () => {
  const files = createSitePages({ ...templates, version: '0.27.17',
    releases: [release('0.27.17', { draft: true }), release('0.27.16'), release('0.29.0-beta.8')] });
  for (const path of ['index.html', 'zh/index.html', 'en/index.html']) {
    assert.deepEqual(links(files, path), download('0.27.16'), path);
    const versionLink = parseHTML(files.get(path)).document.querySelector('.brand-row .brand-version');
    assert.deepEqual([versionLink.textContent, versionLink.href], ['v0.27.16', 'https://github.com/JevonsCode/fuli/releases/tag/v0.27.16'], path);
  }
  for (const path of ['guide/index.html', 'models/index.html', 'report/en/index.html']) {
    assert.equal(parseHTML(files.get(path)).document.querySelector('.brand-row .brand-version').textContent, 'v0.27.16', path);
  }
  assert.match(files.get('next/index.html'), /稳定版 0\.27\.16 就是最新版本/);
  assert.match(files.get('next/en/index.html'), /Stable 0\.27\.16 is the latest release/);
  // Once public with both installers, the next build switches.
  const switched = createSitePages({ ...templates, version: '0.27.17', releases: [release('0.27.17'), release('0.27.16')] });
  assert.deepEqual(links(switched, 'en/index.html'), download('0.27.17'));
});

test('during a beta the stable pages keep the last complete stable release and /next/ the packaged beta', () => {
  const baseline = /data-preview-baseline="([^"]+)"/.exec(templates.preview)[1];
  const files = createSitePages({ ...templates, version: '0.29.0-beta.9',
    releases: [release(baseline, { assets: [`FULI-Setup-${baseline}.exe`] }), release('0.27.16'), release('0.29.0-beta.8')] });
  assert.deepEqual(links(files, 'index.html'), download('0.27.16'), 'the baseline lacks its macOS installer');
  assert.deepEqual(links(files, 'next/index.html'), download('0.29.0-beta.9'));
});

test('a build that read no release list (offline, local) names its own version, and an empty list stops the build', async () => {
  assert.deepEqual(links(createSitePages({ ...templates, version: '0.27.17' }), 'index.html'), download('0.27.17'));
  assert.throws(() => createSitePages({ ...templates, version: '0.27.17', releases: [] }), /left as it is/);
  const folder = mkdtempSync(join(tmpdir(), 'fuli-site-releases-'));
  try {
    const lines = join(folder, 'releases.jsonl');
    writeFileSync(lines, [release('0.27.17', { draft: true }), release('0.27.16')].map(item =>
      JSON.stringify({ ...item, assets: item.assets.map(asset => asset.name) })).join('\n') + '\n');
    assert.equal(publishedStable(await readReleases(lines), '0.27.17'), '0.27.16', 'gh api --jq lines with asset names');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the deploy reads the release list, uses it, and runs again when a publish ends, on main', () => {
  const workflow = read('../.github/workflows/pages.yml');
  assert.match(workflow, /gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/releases\?per_page=100"/);
  assert.match(workflow, /select\(\.state == "uploaded"\)/, 'only installers that finished uploading count');
  assert.match(workflow, /FULI_SITE_RELEASES: \$\{\{ runner\.temp \}\}\/releases\.jsonl/);
  assert.ok(workflow.indexOf('Read published releases') < workflow.indexOf('npm run build:site'));
  assert.match(workflow, /workflow_run:\n\s+workflows: \["Publish npm package"\]\n\s+types: \[completed\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_run' && 'main' \|\| github\.sha \}\}/);
  assert.doesNotMatch(workflow, /^\s+release:/m, 'a release event runs on its tag, which Pages does not deploy');
});
