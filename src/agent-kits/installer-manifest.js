import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { clientDescriptorPacks } from '../setup/agents/registry.js';

// FULI's product manifest for agent-installer (docs/manifest.schema.json):
// what `fuli setup` writes into each client, as data in
// fuli-installer-manifest.json. Two values are filled here rather than
// copied into that file: the FULI version and the Codex instruction block,
// which stays in the Codex descriptor pack. The rest of the `{placeholders}`
// are the installer's variables (installerVariables).
const TEMPLATE = new URL('./fuli-installer-manifest.json', import.meta.url);

export function fuliInstallerManifest({ packs = clientDescriptorPacks() } = {}) {
  const codex = packs.find((pack) => pack.id === 'codex');
  const manifest = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
  manifest.version = FULI_VERSION;
  manifest.clients.codex.instructions.markdown = codex.instructions.global.join('\n');
  return manifest;
}

// The same expected integration `fuli setup` installs (system-service.js's
// client observation context).
export function installerVariables(context) {
  const agents = join(dirname(context.mcpServerPath), 'agents');
  return {
    nodePath: context.nodePath,
    mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath,
    claudeHook: join(agents, 'claude-code', 'lifecycle-hook.js'),
    codexHook: join(agents, 'codex', 'lifecycle-hook.js'),
    cursorHook: join(agents, 'cursor', 'lifecycle-hook.js'),
    skillsDir: dirname(context.sessionSkillPath)
  };
}
