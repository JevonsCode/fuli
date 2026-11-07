import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildSite } from '../scripts/build-site.js';
import { assetVersion, localAsset } from '../scripts/site-asset-versions.js';

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(path);
  }
  return found;
}

// Every reference a browser follows: href/src in pages, imports in modules, url() in stylesheets.
const REFERENCES = {
  '.html': /\b(?:href|src)="([^"]+)"/g,
  '.js': /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g,
  '.css': /\burl\(\s*['"]?([^'")\s]+)['"]?/g,
};

test('every local asset reference in the built site carries the hash of the file it points to', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-site-'));
  try {
    await buildSite(pathToFileURL(root + '/'));
    let checked = 0;
    for (const path of await files(root)) {
      const pattern = REFERENCES[extname(path)];
      if (!pattern) continue;
      const text = await readFile(path, 'utf8');
      const srcsets = extname(path) === '.html' ? [...text.matchAll(/\bsrcset="([^"]+)"/g)].flatMap(([, list]) => list.split(',').map(entry => [null, entry.trim().split(/\s+/)[0]])) : [];
      for (const [, reference] of [...text.matchAll(pattern), ...srcsets]) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference)) continue;
        const [file, query] = reference.split('?');
        const target = await localAsset(path, file);
        if (!target) continue;
        const where = `${relative(root, path)} → ${reference}`;
        assert.equal(query, `v=${assetVersion(await readFile(target))}`, where);
        checked++;
      }
    }
    // The pages, the scroll story's modules and the font in the stylesheet are all covered.
    assert.ok(checked > 100, `only ${checked} references checked`);
    const home = await readFile(join(root, 'index.html'), 'utf8');
    for (const asset of ['style.css', 'scene.css', 'site.js', 'assets/brand/favicon.ico']) assert.match(home, new RegExp(`\\./${asset.replace('.', '\\.')}\\?v=[0-9a-f]{8}"`), asset);
    assert.match(await readFile(join(root, 'site.js'), 'utf8'), /from '\.\/story\.js\?v=[0-9a-f]{8}'/);
    assert.match(await readFile(join(root, 'style.css'), 'utf8'), /url\("\.\/assets\/unbounded-latin\.woff2\?v=[0-9a-f]{8}"\)/);
    // The FLA portraits are drawn at build time, so the pages' references resolve to real files.
    const avatars = (await readdir(join(root, 'assets', 'avatars'))).filter(name => /^fla-\d+\.svg$/.test(name));
    assert.ok(avatars.length >= 24, `${avatars.length} avatars`);
    assert.match(await readFile(join(root, 'assets', 'avatars', 'fla-1.svg'), 'utf8'), /^<svg[\s>]/);
    assert.match(home, /\.\/assets\/avatars\/fla-1\.svg\?v=[0-9a-f]{8}"/);
    // Pages and directories keep plain links.
    assert.match(home, /href="\.\/en\/"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
