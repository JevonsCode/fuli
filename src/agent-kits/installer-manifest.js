import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dshBundleFiles } from '../agents/dsh/bundle.js';
import { openCodePluginSource } from '../agents/opencode/plugin-file.js';
import { FULI_VERSION } from '../package-metadata.js';
import { installedClientPacks } from '../setup/agents/client-pack-store.js';
import { writeDerivedJson, writeDerivedText } from './derived-file.js';
import { packagedSkills, packManifestClient } from './pack-manifest.js';

// FULI's product manifest for agent-installer (docs/manifest.schema.json):
// what FULI installs into each client. The MCP-only clients are data in
// fuli-installer-manifest.json; filled here are the FULI version, each
// descriptor pack client from the active pack (pack-manifest.js),
// OpenCode's plugin, DeepSeek Harness's bundle and a client's prompt files (clientPrompts: client ID to
// a list, e.g. Codex's /fla menu, src/agents/codex/fla-prompts.js; a client
// without a list here gets no `prompts`, so the installer leaves its files
// alone). The rest of the `{placeholders}` are the installer's variables.
const TEMPLATE = new URL('./fuli-installer-manifest.json', import.meta.url);

function fuliInstallerManifest({ packs, openCodePlugin, clientPrompts }) {
  const manifest = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  manifest.version = FULI_VERSION;
  for (const pack of packs) manifest.clients[pack.id] = packManifestClient(pack);
  if (openCodePlugin) manifest.clients.opencode.plugin = { source: '{openCodePlugin}' };
  // DSH reads no MCP file: the bundle starts FULI's MCP server itself.
  manifest.clients.dsh = { mcp: null, plugin: { name: 'fuli', source: '{dshBundle}' }, skills: packagedSkills(false) };
  for (const [id, prompts] of Object.entries(clientPrompts)) {
    if (Array.isArray(prompts) && manifest.clients[id]) manifest.clients[id].prompts = prompts;
  }
  return manifest;
}

// Writes the manifest for this machine and answers its variables. The
// DeepSeek Harness bundle (src/agents/dsh/bundle.js) is written beside it as
// `dsh-bundle/`; agent-installer copies it to `<DSH home>/plugins/fuli` and
// links it into every DSH profile.
// openCodePlugin: whether OpenCode gets FULI's plugin here
// (opencode-plugin-gate.js). Its source is written beside the manifest as
// `opencode-plugin/index.js`; agent-installer puts it at
// `<OpenCode config>/plugins/fuli/index.js`.
export function prepareInstallerManifest({ manifestPath, context, openCodePlugin: plugin,
  packs = installedClientPacks(context.dataDir), clientPrompts = {} }) {
  const pluginDir = join(dirname(manifestPath), 'opencode-plugin');
  const dshBundle = join(dirname(manifestPath), 'dsh-bundle');
  if (plugin) {
    const pack = packs.find((candidate) => candidate.id === 'opencode');
    writeDerivedText(join(pluginDir, 'index.js'), openCodePluginSource(context, pack.lifecycleHooks));
  }
  for (const [name, text] of Object.entries(dshBundleFiles(context))) {
    writeDerivedText(join(dshBundle, name), text);
  }
  writeDerivedJson(manifestPath, fuliInstallerManifest({ packs, openCodePlugin: plugin, clientPrompts }));
  return installerVariables(context, plugin ? pluginDir : null, dshBundle);
}

// The paths of this installation (integration-context.js).
function installerVariables(context, openCodePlugin, dshBundle) {
  const agents = join(dirname(context.mcpServerPath), 'agents');
  return {
    nodePath: context.nodePath,
    mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath,
    claudeHook: join(agents, 'claude-code', 'lifecycle-hook.js'),
    codexHook: join(agents, 'codex', 'lifecycle-hook.js'),
    cursorHook: join(agents, 'cursor', 'lifecycle-hook.js'),
    skillsDir: context.skillsDir,
    dshBundle,
    ...(openCodePlugin ? { openCodePlugin } : {})
  };
}
