import { readFileSync } from 'node:fs';

import { InvalidInputError } from '../app/application-error.js';
import { createUpdatableManifest } from '../registry/updatable-manifest.js';
import { jsonFormat } from '../storage/json-format.js';
import { uniqueTextArray } from '../validation/values.js';
import { OccupationKitChoiceStore } from './choice-store.js';
import { diffOccupationPlugins, parseOccupationPluginManifest, sourceUrl } from './manifest.js';

// Occupation plugins (docs/occupation-plugins.md): each occupation's starter
// kit, read on demand and never put into a task entry. The manifest ships in
// registry/ and updates itself from the public copy once a day unless the
// person turns that off; a kit is upstream text and references, never code.
// Recommended Skills are installed only after the person enables them for an
// FLA; recommended MCP servers are suggestions FULI never connects.
const REMOTE_URL = 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/occupation-plugins.json';
const BUNDLED_MANIFEST = new URL('../../registry/occupation-plugins.json', import.meta.url);
const MAX_MANIFEST_BYTES = 512 * 1024;
export const OCCUPATION_PLUGINS_STATE_FORMAT = jsonFormat({ store: 'occupation-plugins', versions: [1] });

const readBundledManifest = () => JSON.parse(readFileSync(BUNDLED_MANIFEST, 'utf8'));

export function createOccupationPlugins({
  statePath, choicesPath = ':memory:', remoteUrl = REMOTE_URL, fetchImpl = globalThis.fetch,
  now = () => new Date(), readBundled = readBundledManifest
}) {
  const registry = createUpdatableManifest({ statePath, format: OCCUPATION_PLUGINS_STATE_FORMAT, remoteUrl, readBundled,
    parse: parseOccupationPluginManifest, diff: diffOccupationPlugins, changedCode: 'occupation_plugins_changed',
    autoUpdateDefault: true, maxBytes: MAX_MANIFEST_BYTES, fetchImpl, now });
  const choices = new OccupationKitChoiceStore(choicesPath);

  const manifest = () => registry.current().manifest;
  const sourceOf = (catalog, id) => catalog.sources.find(source => source.id === id);
  const pluginFor = (catalog, occupation) => catalog.plugins.find(plugin => plugin.occupations.includes(occupation)) ?? null;

  function reference(catalog, item) {
    const source = sourceOf(catalog, item.source);
    return { id: item.id, name: item.name, url: sourceUrl(source, item.path), license: source.license, summary: item.summary };
  }

  // The occupations page: every plugin with where it came from and its license.
  function list() {
    const { manifest: catalog, source, autoUpdate, lastCheckedAt, history } = registry.current();
    return {
      manifestVersion: catalog.manifestVersion, updatedAt: catalog.updatedAt, source, autoUpdate, lastCheckedAt, history,
      sources: catalog.sources.map(item => ({ id: item.id, repository: item.repository, commit: item.commit,
        license: item.license, copyright: item.copyright, url: sourceUrl(item) })),
      plugins: catalog.plugins.map(plugin => ({
        id: plugin.id, version: plugin.version, digest: plugin.digest, occupations: plugin.occupations,
        role: { name: plugin.role.name, source: plugin.role.source, url: sourceUrl(sourceOf(catalog, plugin.role.source), plugin.role.path) },
        checklistCount: plugin.checklist.items.length, acceptanceCount: plugin.acceptance.items.length,
        skills: plugin.skills.map(item => reference(catalog, item)),
        mcpServers: plugin.mcpServers.map(item => reference(catalog, item))
      }))
    };
  }

  // One occupation's kit, with what the person enabled for this FLA (enabled
  // is null until they answered). A custom occupation may have no plugin.
  function kit({ personalSpaceId, agentId = null, occupation }) {
    const catalog = manifest();
    const plugin = pluginFor(catalog, occupation);
    if (!plugin) return { occupation, plugin: null };
    const [choice = null, ...earlier] = agentId ? choices.history(personalSpaceId, agentId) : [];
    const current = choice?.pluginId === plugin.id ? choice : null;
    const quote = piece => {
      const source = sourceOf(catalog, piece.source);
      return { items: piece.items, from: { source: source.id, url: sourceUrl(source, piece.path), license: source.license } };
    };
    const enabled = (list, item) => current ? current[list].includes(item.id) : null;
    return {
      occupation,
      plugin: { id: plugin.id, version: plugin.version, digest: plugin.digest,
        role: { name: plugin.role.name, url: sourceUrl(sourceOf(catalog, plugin.role.source), plugin.role.path) } },
      checklist: quote(plugin.checklist),
      acceptance: quote(plugin.acceptance),
      skills: plugin.skills.map(item => ({ ...reference(catalog, item), enabled: enabled('skills', item) })),
      mcpServers: plugin.mcpServers.map(item => ({ ...reference(catalog, item), enabled: enabled('mcpServers', item) })),
      choice: current ? { pluginVersion: current.pluginVersion, answeredBy: current.answeredBy, at: current.at,
        outdated: current.pluginDigest !== plugin.digest } : null,
      ...(agentId ? { earlierChoices: earlier.length + (choice && !current ? 1 : 0) } : {})
    };
  }

  // The person's answer for one FLA: a subset of the kit's recommendations.
  function choose({ personalSpaceId, agentId, occupation, skills = [], mcpServers = [], answeredBy = 'person' }) {
    const catalog = manifest();
    const plugin = pluginFor(catalog, occupation);
    if (!plugin) throw new InvalidInputError(`occupation ${occupation} has no starter kit; nothing to enable`);
    const pick = (value, recommended, label) => {
      const ids = uniqueTextArray(value, label, recommended.length);
      const unknown = ids.filter(id => !recommended.some(item => item.id === id));
      if (unknown.length) throw new InvalidInputError(`${label} takes only ids the kit recommends (${recommended.map(item => item.id).join(', ') || 'none'})`);
      return ids;
    };
    choices.add({ personalSpaceId, agentId, pluginId: plugin.id, pluginVersion: plugin.version, pluginDigest: plugin.digest,
      skills: pick(skills, plugin.skills, 'skills'), mcpServers: pick(mcpServers, plugin.mcpServers, 'mcpServers'),
      answeredBy, at: now().toISOString() });
    return kit({ personalSpaceId, agentId, occupation });
  }

  return { list, kit, choose, check: registry.check, apply: registry.apply, setAutoUpdate: registry.setAutoUpdate,
    startAutoUpdate: registry.startAutoUpdate, close: () => choices.close() };
}
