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
// GitHub's release shape: each asset carries its upload state and size.
const uploaded = name => ({ name, state: 'uploaded', size: 255_000_000 });
const release = (version, { draft = false, prerelease = version.includes('-'), assets = stableInstallers(version),
  tag = `v${version}` } = {}) =>
  ({ tag_name: tag, draft, prerelease, assets: assets.map(asset => (typeof asset === 'string' ? uploaded(asset) : asset)) });
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
  // Review 11-19: installers still being attached (state starter, size 0), uploaded but empty,
  // or a tag without its v (whose /v0.27.17/ path does not exist) never count.
  const attaching = stableInstallers('0.27.17').map(name => ({ name, state: 'starter', size: 0 }));
  assert.equal(publishedStable([release('0.27.17', { assets: attaching }), shipped], '0.27.17'), '0.27.16');
  const empty = stableInstallers('0.27.17').map(name => ({ name, state: 'uploaded', size: 0 }));
  assert.equal(publishedStable([release('0.27.17', { assets: empty }), shipped], '0.27.17'), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { tag: '0.27.17' }), shipped], '0.27.17'), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { tag: 'vnot-a-version' }), shipped], '0.27.17'), '0.27.16');
  assert.equal(publishedStable([{ ...release('0.27.17'), draft: undefined }, shipped], '0.27.17'), '0.27.16',
    'a release that does not say it is public is not');
  // Public with both installers uploaded and non-empty: the site switches to it.
  assert.equal(publishedStable([release('0.27.17'), shipped], '0.27.17'), '0.27.17');
});

// The two release states of 11-19, end to end (both read like the live list):
// 0.27.17 still a draft, and 0.27.17 public with both installers; beta.8 public all along.
const LIVE_DRAFT = [release('0.27.17', { draft: true }), release('0.27.16'), release('0.29.0-beta.8'), release('0.29.0-beta.2')];
const LIVE_RELEASED = [release('0.27.17'), release('0.27.16'), release('0.29.0-beta.8'), release('0.29.0-beta.2')];
const notesLink = version => `https://github.com/JevonsCode/fuli/releases/tag/v${version}`;

function assertPreview(files, version, stable) {
  for (const [path, locale] of [['next/index.html', 'zh-CN'], ['next/zh/index.html', 'zh-CN'], ['next/en/index.html', 'en']]) {
    const { document } = parseHTML(files.get(path));
    assert.equal(document.documentElement.lang, locale, path);
    assert.deepEqual(links(files, path), download(version), path);
    assert.deepEqual([...document.querySelectorAll('[data-preview-version]')].map(node => node.textContent), [version], path);
    for (const link of document.querySelectorAll('[data-preview-release]')) assert.equal(link.href, notesLink(version), path);
    assert.equal(document.querySelector('.brand-version').textContent, 'v' + version, path);
    // This build does not package that beta: its changes are in its release notes, not a list written for another version.
    assert.equal(document.querySelector('.preview-changes'), null, path);
    assert.equal(document.querySelector('a[href="#changes"]'), null, path);
    assert.ok(document.querySelector('[data-preview-release]'), path);
    const hero = document.querySelector('.lede').textContent;
    assert.match(hero, locale === 'en' ? new RegExp(`since stable ${stable.replace(/\./g, '\\.')} is in this version's release notes`)
      : new RegExp(`稳定版 ${stable.replace(/\./g, '\\.')} 的全部变化，写在这个版本的发布说明里`), path);
    assert.doesNotMatch(document.querySelector('meta[name="description"]').content, /0\.27\.17 的全部新功能|since stable 0\.27\.17\. One/, path);
  }
  assert.match(files.get('sitemap.xml'), /\/next\//, 'the preview is in the sitemap');
}

test('live, 0.27.17 a draft: stable pages name and download 0.27.16; /next/ is beta.8 in every language', () => {
  const files = createSitePages({ ...templates, version: '0.27.17', releases: LIVE_DRAFT });
  for (const path of ['index.html', 'zh/index.html', 'en/index.html']) {
    assert.deepEqual(links(files, path), download('0.27.16'), path);
    const versionLink = parseHTML(files.get(path)).document.querySelector('.brand-row .brand-version');
    assert.deepEqual([versionLink.textContent, versionLink.href], ['v0.27.16', notesLink('0.27.16')], path);
  }
  for (const path of ['guide/index.html', 'models/index.html', 'report/en/index.html']) {
    assert.equal(parseHTML(files.get(path)).document.querySelector('.brand-row .brand-version').textContent, 'v0.27.16', path);
  }
  assertPreview(files, '0.29.0-beta.8', '0.27.16');
});

test('live, 0.27.17 released with both installers: stable pages switch to it and beta.8 stays the preview', () => {
  const files = createSitePages({ ...templates, version: '0.27.17', releases: LIVE_RELEASED });
  for (const path of ['index.html', 'en/index.html']) assert.deepEqual(links(files, path), download('0.27.17'), path);
  assertPreview(files, '0.29.0-beta.8', '0.27.17');
});

test('a newer draft or incomplete beta is passed over for the newest complete one; none ahead says no preview', () => {
  const draft9 = release('0.29.0-beta.9', { draft: true });
  const broken9 = release('0.29.0-beta.9', { assets: ['FULI-Setup-0.29.0-beta.9.exe'] });
  const attaching9 = release('0.29.0-beta.9', { assets: stableInstallers('0.29.0-beta.9').map(name => ({ name, state: 'starter', size: 0 })) });
  for (const late of [draft9, broken9, attaching9]) {
    assertPreview(createSitePages({ ...templates, version: '0.27.17', releases: [...LIVE_DRAFT, late] }), '0.29.0-beta.8', '0.27.16');
  }
  // Only betas behind the stable release: no preview.
  const behind = [release('0.27.17'), release('0.27.16'), release('0.27.17-beta.1')];
  const files = createSitePages({ ...templates, version: '0.27.17', releases: behind });
  assert.match(files.get('next/index.html'), /稳定版 0\.27\.17 就是最新版本/);
  assert.match(files.get('next/en/index.html'), /Stable 0\.27\.17 is the latest release/);
  assert.doesNotMatch(files.get('sitemap.xml'), /\/next\//);
});

test('a beta build whose own beta is public keeps its change list; while it is not, the newest public beta shows', () => {
  const baseline = /data-preview-baseline="([^"]+)"/.exec(templates.preview)[1];
  const packaged = createSitePages({ ...templates, version: '0.29.0-beta.9', releases: [...LIVE_RELEASED, release('0.29.0-beta.9')] });
  const { document } = parseHTML(packaged.get('next/index.html'));
  assert.deepEqual(links(packaged, 'next/index.html'), download('0.29.0-beta.9'));
  assert.ok(document.querySelector('.preview-changes'), 'this build is that beta: its change list stays');
  assert.deepEqual(links(packaged, 'index.html'), download(baseline === '0.27.17' ? '0.27.17' : '0.27.16'));
  const unpublished = createSitePages({ ...templates, version: '0.29.0-beta.9',
    releases: [release(baseline, { assets: [`FULI-Setup-${baseline}.exe`] }), release('0.27.16'), release('0.29.0-beta.8')] });
  assert.deepEqual(links(unpublished, 'index.html'), download('0.27.16'), 'the baseline lacks its macOS installer');
  assertPreview(unpublished, '0.29.0-beta.8', '0.27.16');
});

test('a build that read no release list (offline, local) names its own version, and an empty list stops the build', async () => {
  assert.deepEqual(links(createSitePages({ ...templates, version: '0.27.17' }), 'index.html'), download('0.27.17'));
  assert.throws(() => createSitePages({ ...templates, version: '0.27.17', releases: [] }), /left as it is/);
  const folder = mkdtempSync(join(tmpdir(), 'fuli-site-releases-'));
  try {
    const lines = join(folder, 'releases.jsonl');
    writeFileSync(lines, [release('0.27.17', { draft: true }), release('0.27.16')].map(item => JSON.stringify(item)).join('\n') + '\n');
    assert.equal(publishedStable(await readReleases(lines), '0.27.17'), '0.27.16', 'gh api --jq lines with name, state and size');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('the deploy reads the release list, uses it, and runs again when a publish ends, on main', () => {
  const workflow = read('../.github/workflows/pages.yml');
  assert.match(workflow, /gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/releases\?per_page=100"/);
  assert.match(workflow, /assets: \[\.assets\[\] \| \{name, state, size\}\]/, 'each installer keeps its upload state and size');
  assert.match(workflow, /FULI_SITE_RELEASES: \$\{\{ runner\.temp \}\}\/releases\.jsonl/);
  assert.ok(workflow.indexOf('Read published releases') < workflow.indexOf('npm run build:site'));
  assert.match(workflow, /workflow_run:\n\s+workflows: \["Publish npm package"\]\n\s+types: \[completed\]/);
  assert.match(workflow, /ref: \$\{\{ github\.event_name == 'workflow_run' && 'main' \|\| github\.sha \}\}/);
  assert.doesNotMatch(workflow, /^\s+release:/m, 'a release event runs on its tag, which Pages does not deploy');
});

// The redeploy waits for both installers: they are uploaded by jobs of the workflow the
// deploy listens to, after its publish job, so its completion comes after both uploads.
test('both installers are uploaded inside "Publish npm package", after publishing, so its end redeploys the site', () => {
  const release = read('../.github/workflows/release.yml');
  assert.match(release, /^name: Publish npm package$/m);
  assert.match(release, /^on:\n\s+release:\n\s+types:/m);
  // Each job is the block from its two-space key to the next one.
  const jobs = Object.fromEntries(release.split(/\n(?=  [a-z][a-z-]*:\n)/).map(block => [/^ {2}([a-z][a-z-]*):/.exec(block)?.[1], block]));
  for (const [name, upload] of [['windows-tray', /gh release upload "\$env:GITHUB_REF_NAME"/], ['macos-dmg', /gh release upload "\$GITHUB_REF_NAME"/]]) {
    const body = jobs[name] ?? '';
    assert.match(body, /needs: publish/, `${name} runs after publishing`);
    assert.match(body, upload, `${name} uploads its installer to the release`);
  }
});
