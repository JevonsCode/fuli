import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { parseDocument } from 'yaml';

import { createSitePages } from '../scripts/build-site.js';
import { createLanguageController } from '../site/i18n.js';
import * as previewCatalog from '../site/next/translations.js';
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
  assert.equal(publishedStable([release('0.27.17', { draft: true }), shipped, release('0.29.0-beta.8')]), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { assets: ['FULI-Setup-0.27.17.exe'] }), shipped]), '0.27.16',
    'Windows alone is not enough');
  assert.equal(publishedStable([release('0.27.17', { assets: ['fuli-macos-arm64-0.27.17.dmg'] }), shipped]), '0.27.16',
    'macOS alone is not enough');
  assert.equal(publishedStable([release('0.27.17', { prerelease: true }), shipped]), '0.27.16', 'marked prerelease');
  // A newer public, complete release is chosen whatever version the build carries.
  assert.equal(publishedStable([release('0.27.18'), shipped]), '0.27.18');
  assert.equal(publishedStable([release('0.27.17', { draft: true })]), null);
  // Review 11-19: installers still being attached (state starter, size 0), uploaded but empty,
  // or a tag without its v (whose /v0.27.17/ path does not exist) never count.
  const attaching = stableInstallers('0.27.17').map(name => ({ name, state: 'starter', size: 0 }));
  assert.equal(publishedStable([release('0.27.17', { assets: attaching }), shipped]), '0.27.16');
  const empty = stableInstallers('0.27.17').map(name => ({ name, state: 'uploaded', size: 0 }));
  assert.equal(publishedStable([release('0.27.17', { assets: empty }), shipped]), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { tag: '0.27.17' }), shipped]), '0.27.16');
  assert.equal(publishedStable([release('0.27.17', { tag: 'vnot-a-version' }), shipped]), '0.27.16');
  assert.equal(publishedStable([{ ...release('0.27.17'), draft: undefined }, shipped]), '0.27.16',
    'a release that does not say it is public is not');
  // Public with both installers uploaded and non-empty: the site switches to it.
  assert.equal(publishedStable([release('0.27.17'), shipped]), '0.27.17');
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

test('a stable release published after this commit (0.27.18) switches all three stable paths; beta.8 stays the preview', () => {
  const files = createSitePages({ ...templates, version: '0.27.17', releases: [release('0.27.18'), ...LIVE_RELEASED] });
  for (const path of ['index.html', 'zh/index.html', 'en/index.html']) {
    assert.deepEqual(links(files, path), download('0.27.18'), path);
    assert.equal(parseHTML(files.get(path)).document.querySelector('.brand-row .brand-version').textContent, 'v0.27.18', path);
  }
  assertPreview(files, '0.29.0-beta.8', '0.27.18');
  // A local build without the list still names its own version.
  assert.deepEqual(links(createSitePages({ ...templates, version: '0.27.17' }), 'en/index.html'), download('0.27.17'));
});

// 11-19 (after #1045): an English browser opening /next/ with no language in the path got
// English headings and buttons, but the release-notes sentence stayed Chinese: the build
// wrote it in zh and dropped its data-i18n. It is translatable again, the stable version its argument.
test('/next/ without a language: the release-notes sentence follows the browser, an explicit choice and a saved one', () => {
  const files = createSitePages({ ...templates, version: '0.27.17', releases: LIVE_DRAFT });
  const english = /^A public preview of the next release, .* since stable 0\.27\.16 is in this version's release notes\.$/;
  const chinese = /相对稳定版 0\.27\.16 的全部变化，写在这个版本的发布说明里/;
  const saved = new Map();
  const getStorage = () => ({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  const open = languages => {
    const { document } = parseHTML(files.get('next/index.html'));
    const language = createLanguageController({ document, languages, getStorage, catalog: previewCatalog });
    return { document, language, lede: () => document.querySelector('.lede').textContent };
  };
  // Automatic: the first browser language.
  const en = open(['en-US', 'en']);
  assert.equal(en.document.documentElement.lang, 'en');
  assert.match(en.lede(), english);
  assert.doesNotMatch(en.lede(), /[一-鿿]/, 'no Chinese left in the English sentence');
  assert.match(open(['zh-CN']).lede(), chinese);
  // Explicit: a click switches it, and the choice is saved.
  en.language.setLocale('zh-CN');
  assert.match(en.lede(), chinese, 'an explicit choice switches it');
  // Saved: the next visit from an English browser keeps the saved Chinese; saved English wins over a Chinese browser.
  assert.match(open(['en-US']).lede(), chinese);
  saved.set('fuli.site.language', 'en');
  assert.match(open(['zh-CN']).lede(), english);
  // The beta's release link and the single-language pages are unchanged.
  for (const link of en.document.querySelectorAll('[data-preview-release]')) assert.match(link.href, /releases\/tag\/v0\.29\.0-beta\.8$/);
  assertPreview(files, '0.29.0-beta.8', '0.27.16');
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
    assert.equal(publishedStable(await readReleases(lines)), '0.27.16', 'gh api --jq lines with name, state and size');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// The workflows as GitHub reads them: parsed YAML, not their text. 11-19: a one-line
// run: with the jq filter's braces and colons failed to parse (BLOCK_AS_IMPLICIT_KEY)
// and the deploy ran no job.
const workflow = name => {
  const document = parseDocument(read(`../.github/workflows/${name}`));
  assert.deepEqual(document.errors.map(error => error.code), [], `${name} parses`);
  return document.toJS();
};

test('every workflow parses as YAML', () => {
  for (const name of readdirSync(new URL('../.github/workflows/', import.meta.url)).filter(file => /\.ya?ml$/.test(file))) workflow(name);
});

test('the deploy reads the release list, builds from it, and runs again on main when a publish ends', () => {
  const pages = workflow('pages.yml');
  assert.deepEqual(pages.on.push.branches, ['main']);
  assert.deepEqual(pages.on.workflow_run, { workflows: ['Publish npm package'], types: ['completed'] });
  assert.equal('release' in pages.on, false, 'a release event runs on its tag, which Pages does not deploy');
  const steps = pages.jobs.deploy.steps;
  assert.equal(steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref,
    "${{ github.event_name == 'workflow_run' && 'main' || github.sha }}");
  const read = steps.findIndex(step => step.name === 'Read published releases');
  const build = steps.findIndex(step => step.run === 'npm run build:site');
  assert.ok(read >= 0 && build > read, 'the list is read before the build');
  const command = steps[read].run.replace(/\\\n\s*/g, ' ');
  assert.match(command, /^gh api --paginate "repos\/\$\{\{ github\.repository \}\}\/releases\?per_page=100"/);
  assert.match(command, /--jq '\.\[\] \| \{tag_name, draft, prerelease, assets: \[\.assets\[\] \| \{name, state, size\}\]\}'/);
  assert.match(command, /> "\$RUNNER_TEMP\/releases\.jsonl"\s*$/);
  assert.equal(steps[read].env.GH_TOKEN, '${{ github.token }}');
  assert.equal(steps[build].env.FULI_SITE_RELEASES, '${{ runner.temp }}/releases.jsonl');
  assert.ok(steps.findIndex(step => step.uses?.startsWith('actions/deploy-pages@')) > build, 'it deploys what it built');
});

// The redeploy waits for both installers: they are uploaded by jobs of the workflow the
// deploy listens to, after its publish job, so its completion comes after both uploads.
test('both installers are uploaded inside "Publish npm package", after publishing, so its end redeploys the site', () => {
  const release = workflow('release.yml');
  assert.equal(release.name, 'Publish npm package');
  assert.ok(release.on.release.types.includes('published'));
  for (const [name, upload] of [['windows-tray', /gh release upload "\$env:GITHUB_REF_NAME"/], ['macos-dmg', /gh release upload "\$GITHUB_REF_NAME"/]]) {
    const job = release.jobs[name];
    assert.ok([job.needs].flat().includes('publish'), `${name} runs after publishing`);
    assert.ok(job.steps.some(step => upload.test(step.run ?? '')), `${name} uploads its installer to the release`);
  }
});
