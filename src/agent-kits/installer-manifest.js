import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openCodePluginSource } from '../agents/opencode/plugin-file.js';
import { FULI_VERSION } from '../package-metadata.js';
import { openCodePluginKept } from '../setup/agents/opencode/config-writer.js';
import { clientDescriptorPacks } from '../setup/agents/registry.js';
import { writeDerivedJson, writeDerivedText } from './derived-file.js';

// FULI's product manifest for agent-installer (docs/manifest.schema.json):
// what `fuli setup` writes into each client, as data in
// fuli-installer-manifest.json. Filled here rather than copied into that
// file: the FULI version, the Codex instruction block, which stays in the
// Codex descriptor pack, and OpenCode's plugin. The rest of the
// `{placeholders}` are the installer's variables.
const TEMPLATE = new URL('./fuli-installer-manifest.json', import.meta.url);

function fuliInstallerManifest({ packs = clientDescriptorPacks(), openCodePlugin = false } = {}) {
  const codex = packs.find((pack) => pack.id === 'codex');
  const manifest = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  manifest.version = FULI_VERSION;
  manifest.clients.codex.instructions.markdown = codex.instructions.global.join('\n');
  if (openCodePlugin) manifest.clients.opencode.plugin = { source: '{openCodePlugin}' };
  return manifest;
}

// Writes the manifest for this machine and answers its variables. FULI's
// OpenCode writer keeps a plugin only in OpenCode 2.x (rec#11 D-63), so the
// manifest names it only where the writer would: the plugin's source is
// written beside the manifest as `opencode-plugin/index.js`, the file the
// writer puts at `<OpenCode config>/plugins/fuli/index.js`.
// targets: FULI's writer targets (agentTargets), for OpenCode's version.
export function prepareInstallerManifest({ manifestPath, context, targets, packs = clientDescriptorPacks() }) {
  const opencode = targets.find((target) => target.id === 'opencode');
  const plugin = Boolean(opencode?.pluginPath) && openCodePluginKept(opencode);
  const pluginDir = join(dirname(manifestPath), 'opencode-plugin');
  if (plugin) {
    const pack = packs.find((candidate) => candidate.id === 'opencode');
    writeDerivedText(join(pluginDir, 'index.js'), openCodePluginSource(context, pack.lifecycleHooks));
  }
  writeDerivedJson(manifestPath, fuliInstallerManifest({ packs, openCodePlugin: plugin }));
  return installerVariables(context, plugin ? pluginDir : null);
}

// The same expected integration `fuli setup` installs (integration-context.js).
function installerVariables(context, openCodePlugin) {
  const agents = join(dirname(context.mcpServerPath), 'agents');
  return {
    nodePath: context.nodePath,
    mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath,
    claudeHook: join(agents, 'claude-code', 'lifecycle-hook.js'),
    codexHook: join(agents, 'codex', 'lifecycle-hook.js'),
    cursorHook: join(agents, 'cursor', 'lifecycle-hook.js'),
    skillsDir: dirname(context.sessionSkillPath),
    ...(openCodePlugin ? { openCodePlugin } : {})
  };
}
