import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';

// GitHub Pages serves every file with a ten-minute cache, so after a deploy a browser could pair
// new HTML with old CSS or JavaScript (or the reverse). Every local asset reference in the built
// site therefore carries ?v=<first 8 hex digits of the SHA-256 of the file as served>. A module's
// hash covers its own rewritten imports, so changing a dependency changes every importer's URL too.

const TEXT = new Set(['.html', '.js', '.css']);
const ASSET = new Set(['.js', '.css', '.svg', '.png', '.ico', '.jpg', '.webp', '.woff2', '.json']);
// href/src in HTML; static, re-exported and dynamic imports in JavaScript; url() and @import in CSS.
const PATTERNS = {
  '.html': /(\b(?:href|src)=")([^"]+)(")/g,
  '.js': /(\b(?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"]+)(['"])/g,
  '.css': /(\burl\(\s*['"]?|@import\s+['"])(\.{1,2}\/[^'")\s]+)(['"]?)/g,
};

export const assetVersion = content => createHash('sha256').update(content).digest('hex').slice(0, 8);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

// The local file a reference points to, or null for pages, anchors and other origins.
export async function localAsset(from, reference) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(reference) || reference.includes('?')) return null;
  const path = resolve(dirname(from), reference.split('#')[0]);
  if (!ASSET.has(extname(path))) return null;
  try { return (await stat(path)).isFile() ? path : null; } catch { return null; }
}

export async function stampAssetVersions(root) {
  const versions = new Map();
  const visiting = new Set();

  async function rewrite(path) {
    const pattern = PATTERNS[extname(path)];
    const text = await readFile(path, 'utf8');
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const [whole, before, reference, after] = match;
      const target = await localAsset(path, reference);
      if (!target) continue;
      parts.push(text.slice(last, match.index), before, reference, '?v=', await versionOf(target), after);
      last = match.index + whole.length;
    }
    parts.push(text.slice(last));
    return parts.join('');
  }

  async function versionOf(path) {
    if (versions.has(path)) return versions.get(path);
    if (visiting.has(path)) throw new Error(`Asset import cycle at ${relative(root, path)}`);
    visiting.add(path);
    let content;
    if (TEXT.has(extname(path))) {
      content = await rewrite(path);
      await writeFile(path, content);
    } else content = await readFile(path);
    visiting.delete(path);
    const version = assetVersion(content);
    versions.set(path, version);
    return version;
  }

  for (const path of await listFiles(root)) {
    if (extname(path) === '.html') await writeFile(path, await rewrite(path));
    else if (TEXT.has(extname(path))) await versionOf(path);
  }
  return versions;
}
