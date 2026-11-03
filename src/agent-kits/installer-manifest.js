import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openCodePluginSource } from '../agents/opencode/plugin-file.js';
import { FULI_VERSION } from '../package-metadata.js';
import { installedClientPacks } from '../setup/agents/client-pack-store.js';
import { writeDerivedJson, writeDerivedText } from './derived-file.js';
import { packManifestClient } from './pack-manifest.js';

// FULI's product manifest for agent-installer (docs/manifest.schema.json):
// what FULI installs into each client. The MCP-only clients are data in
// fuli-installer-manifest.json; filled here are the FULI version, each
// descriptor pack client from the active pack (pack-manifest.js) and
// OpenCode's plugin. The rest of the `{placeholders}` are the installer's
// variables.
const TEMPLATE = new URL('./fuli-installer-manifest.json', import.meta.url);

function fuliInstallerManifest({ packs, openCodePlugin }) {
  const manifest = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  manifest.version = FULI_VERSION;
  for (const pack of packs) manifest.clients[pack.id] = packManifestClient(pack);
  if (openCodePlugin) manifest.clients.opencode.plugin = { source: '{openCodePlugin}' };
  return manifest;
}

// Writes the manifest for this machine and answers its variables.
// openCodePlugin: whether OpenCode gets FULI's plugin here
// (opencode-plugin-gate.js). Its source is written beside the manifest as
// `opencode-plugin/index.js`; agent-installer puts it at
// `<OpenCode config>/plugins/fuli/index.js`.
export function prepareInstallerManifest({ manifestPath, context, openCodePlugin: plugin,
  packs = installedClientPacks(context.dataDir) }) {
  const pluginDir = join(dirname(manifestPath), 'opencode-plugin');
  if (plugin) {
    const pack = packs.find((candidate) => candidate.id === 'opencode');
    writeDerivedText(join(pluginDir, 'index.js'), openCodePluginSource(context, pack.lifecycleHooks));
  }
  writeDerivedJson(manifestPath, fuliInstallerManifest({ packs, openCodePlugin: plugin }));
  return installerVariables(context, plugin ? pluginDir : null);
}

// The paths of this installation (integration-context.js).
function installerVariables(context, openCodePlugin) {
  const agents = join(dirname(context.mcpServerPath), 'agents');
  return {
    nodePath: context.nodePath,
    mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath,
    claudeHook: join(agents, 'claude-code', 'lifecycle-hook.js'),
    codexHook: join(agents, 'codex', 'lifecycle-hook.js'),
    cursorHook: join(agents, 'cursor', 'lifecycle-hook.js'),
    skillsDir: context.skillsDir,
    ...(openCodePlugin ? { openCodePlugin } : {})
  };
}
