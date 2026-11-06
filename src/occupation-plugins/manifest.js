import { z } from 'zod';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { packageIdentifier, packageVersion } from '../employees/manifest.js';
import { deepFreeze } from '../validation/values.js';

// The occupation plugin manifest (registry/occupation-plugins.json,
// docs/occupation-plugins.md): for each occupation, a starter kit curated from
// open-source collections. FULI writes none of the role text: the checklist and
// acceptance items are quoted from a named upstream file at a pinned commit, and
// Skills and MCP servers are references, never copies. A manifest is accepted
// only whole and only when every field is exactly as documented.

const FORMAT_ID = 'fuli-occupation-plugins';
const FORMAT_VERSION = 1;
const DIGEST_PREFIX = 'sha256:';
// Licenses whose text FULI may quote with attribution or point to. Anything
// else (no license, non-commercial, source-available) is refused.
const PERMISSIVE_LICENSES = Object.freeze(['MIT', 'Apache-2.0', 'MIT OR Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0']);
const MAX_SOURCES = 64;
const MAX_PLUGINS = 64;
const MAX_ITEMS = 16;
const MAX_REFERENCES = 6;
const MAX_OCCUPATIONS = 12;

class OccupationPluginManifestError extends TypeError {
  constructor(message) {
    super(`Occupation plugin manifest: ${message}`);
    this.code = 'occupation_plugins_invalid';
  }
}

const fail = message => { throw new OccupationPluginManifestError(message); };
// Exactly as written: the digest covers these bytes, so nothing is trimmed on the way in.
const trimmed = value => value === value.trim();
const line = max => z.string().min(1).max(max)
  .refine(value => trimmed(value) && !/[\u0000-\u001f\u007f]/.test(value), 'one trimmed line of text');
const httpsUrl = z.string().max(512).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'an https URL without credentials, query or fragment');
// A path inside the upstream repository, as its tree shows it.
const repoPath = z.string().min(1).max(240).refine(value => !value.startsWith('/') && !value.includes('\\')
  && !value.split('/').some(part => !part || part === '.' || part === '..'), 'a path inside the repository');
const occupationKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const sourceSchema = z.object({
  id: packageIdentifier,
  repository: httpsUrl,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  license: z.enum(PERMISSIVE_LICENSES),
  // The upstream copyright line and license text travel with what is quoted from it.
  copyright: line(300).nullable(),
  licenseText: z.string().min(1).max(24_000).refine(trimmed, 'trimmed text').nullable()
}).strict();

const quoted = z.object({
  source: packageIdentifier,
  path: repoPath,
  items: z.array(line(400)).min(1).max(MAX_ITEMS)
}).strict();

const reference = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/@-]{0,127}$/),
  name: line(80),
  source: packageIdentifier,
  path: repoPath.nullable(),
  // The upstream's own one-line description.
  summary: line(600)
}).strict();

const pluginSchema = z.object({
  id: packageIdentifier,
  version: packageVersion,
  occupations: z.array(occupationKey).min(1).max(MAX_OCCUPATIONS),
  role: z.object({ source: packageIdentifier, path: repoPath, name: line(80) }).strict(),
  checklist: quoted,
  acceptance: quoted,
  skills: z.array(reference).max(MAX_REFERENCES),
  mcpServers: z.array(reference).max(MAX_REFERENCES),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/)
}).strict();

const manifestSchema = z.object({
  format: z.literal(FORMAT_ID),
  formatVersion: z.literal(FORMAT_VERSION),
  manifestVersion: z.number().int().min(1),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)), 'a date'),
  sources: z.array(sourceSchema).min(1).max(MAX_SOURCES),
  plugins: z.array(pluginSchema).min(1).max(MAX_PLUGINS)
}).strict();

// The sources a plugin names, in the order it names them.
function sourceIdsOf(plugin) {
  return [...new Set([plugin.role.source, plugin.checklist.source, plugin.acceptance.source,
    ...plugin.skills.map(item => item.source), ...plugin.mcpServers.map(item => item.source)])];
}

// A plugin's digest covers its content and every source it names (commit,
// license), so a pinned version identifies exactly what a person agreed to.
// It identifies content; it never proves where a copy came from.
export function occupationPluginDigest(plugin, sources) {
  const { digest: _digest, ...content } = plugin;
  const named = sourceIdsOf(plugin).map(id => sources.find(source => source.id === id) ?? null);
  return `${DIGEST_PREFIX}${contentHash({ plugin: content, sources: named })}`;
}

export function parseOccupationPluginManifest(value) {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const manifest = parsed.data;
  const sources = new Map();
  for (const source of manifest.sources) {
    if (sources.has(source.id)) fail(`duplicate source ${source.id}`);
    sources.set(source.id, source);
  }
  const plugins = new Set();
  const served = new Map();
  for (const plugin of manifest.plugins) {
    if (plugins.has(plugin.id)) fail(`duplicate plugin ${plugin.id}`);
    plugins.add(plugin.id);
    for (const id of sourceIdsOf(plugin)) if (!sources.has(id)) fail(`plugin ${plugin.id} names unknown source ${id}`);
    // Quoted text carries its upstream license with it.
    for (const piece of [plugin.checklist, plugin.acceptance]) {
      if (!sources.get(piece.source).licenseText) fail(`plugin ${plugin.id} quotes ${piece.source} without its license text`);
    }
    for (const list of [plugin.skills, plugin.mcpServers]) {
      if (new Set(list.map(item => item.id)).size !== list.length) fail(`plugin ${plugin.id} repeats a reference`);
    }
    if (new Set(plugin.occupations).size !== plugin.occupations.length) fail(`plugin ${plugin.id} repeats an occupation`);
    // One kit per occupation, so an FLA's kit is never a guess.
    for (const key of plugin.occupations) {
      if (served.has(key)) fail(`occupation ${key} is served by ${served.get(key)} and ${plugin.id}`);
      served.set(key, plugin.id);
    }
    if (occupationPluginDigest(plugin, manifest.sources) !== plugin.digest) fail(`plugin ${plugin.id} does not match its digest`);
  }
  return deepFreeze(structuredClone(manifest));
}

// A link to a source's file or folder at its pinned commit.
export function sourceUrl(source, path = null) {
  if (!path) return `${source.repository}/tree/${source.commit}`;
  return `${source.repository}/${/\.[a-z0-9]+$/i.test(path) ? 'blob' : 'tree'}/${source.commit}/${path}`;
}

// What an update adds, changes (by version or digest) and removes.
export function diffOccupationPlugins(current, next) {
  const before = new Map(current.plugins.map(plugin => [plugin.id, plugin]));
  const after = new Map(next.plugins.map(plugin => [plugin.id, plugin]));
  return {
    fromVersion: current.manifestVersion,
    toVersion: next.manifestVersion,
    added: next.plugins.filter(plugin => !before.has(plugin.id)).map(plugin => ({ id: plugin.id, version: plugin.version })),
    changed: next.plugins.filter(plugin => before.has(plugin.id) && before.get(plugin.id).digest !== plugin.digest)
      .map(plugin => ({ id: plugin.id, from: before.get(plugin.id).version, to: plugin.version })),
    removed: current.plugins.filter(plugin => !after.has(plugin.id)).map(plugin => ({ id: plugin.id, version: plugin.version }))
  };
}
