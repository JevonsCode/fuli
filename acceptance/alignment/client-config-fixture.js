import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { packManifestClient } from '../../src/agent-kits/pack-manifest.js';
import { quoteShellArgument } from '../../src/cli/shell-argument.js';
import { loadClientDescriptorPacks } from '../../src/setup/agents/descriptor-packs.js';

// The FULI entries agent-installer writes into a client, written into the
// synthetic configuration files a run hands Claude Code or Cursor by path:
// the same MCP arguments and hook commands as FULI's product manifest
// (src/agent-kits/pack-manifest.js), never the person's own client files.
// context: { nodePath, mcpServerPath, runtimeConfigPath }.

const pack = (id) => loadClientDescriptorPacks().find((candidate) => candidate.id === id);
const fill = (values, context) => values.flatMap((value) => {
  if (value === '{nodePath}') return [context.nodePath];
  if (value === '{mcpServerPath}') return [context.mcpServerPath];
  if (value === '{runtimeConfigPath}') return [context.runtimeConfigPath];
  if (value === '{claudeHook}') return [join(dirname(context.mcpServerPath), 'agents', 'claude-code', 'lifecycle-hook.js')];
  return [value];
});
const CLAUDE_EVENTS = Object.freeze({ sessionStart: 'SessionStart', userPromptSubmit: 'UserPromptSubmit', stop: 'Stop', preCompact: 'PreCompact' });

function mergeServer(configPath, server) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, fuli: server } }, null, 2)}\n`);
}

// Claude Code: the MCP entry in configPath, lifecycle hooks and FULI's
// permissions in settingsPath; hookTimeoutSec replaces the pack's timeout.
export function writeClaudeCodeFixture({ configPath, settingsPath }, context, { hookTimeoutSec }) {
  const base = pack('claude-code');
  const client = packManifestClient({ ...base, lifecycleHooks: { ...base.lifecycleHooks, timeoutSec: hookTimeoutSec } });
  mergeServer(configPath, { type: 'stdio', command: context.nodePath, args: fill(client.mcp.args, context) });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const hooks = { ...settings.hooks };
  for (const [key, hook] of Object.entries(client.hooks.events)) {
    hooks[CLAUDE_EVENTS[key]] = [{ hooks: [{ type: 'command', timeout: hook.timeoutSec, statusMessage: hook.statusMessage,
      command: fill(hook.command, context).map((value) => quoteShellArgument(value)).join(' ') }] }];
  }
  const allow = [...(settings.permissions?.allow ?? []), ...client.permissions.allow];
  writeFileSync(settingsPath, `${JSON.stringify({ ...settings, hooks, permissions: { ...settings.permissions, allow } }, null, 2)}\n`);
}

// Cursor: only the MCP entry in configPath, created when absent.
export function writeCursorMcpFixture({ configPath }, context) {
  mkdirSync(dirname(configPath), { recursive: true });
  try { readFileSync(configPath); } catch { writeFileSync(configPath, '{}\n'); }
  mergeServer(configPath, { command: context.nodePath, args: fill(packManifestClient(pack('cursor')).mcp.args, context) });
}
