import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export function discoverAgents({
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  commandExists = (command) => defaultCommandExists(command, platform)
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const codexHome = nonEmpty(env.CODEX_HOME) ?? pathApi.join(homeDir, '.codex');
  return [
    {
      id: 'codex',
      label: 'Codex',
      command: 'codex',
      configPath: pathApi.join(codexHome, 'config.toml'),
      available: Boolean(commandExists('codex'))
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      configPath: pathApi.join(homeDir, '.claude.json'),
      available: Boolean(commandExists('claude'))
    }
  ];
}

export function buildAgentCommands(agent, context) {
  const mcpArgs = [
    context.nodePath,
    context.mcpServerPath,
    '--db',
    context.dbPath,
    '--personal-space',
    context.personalSpaceName
  ];
  if (agent.id === 'codex') {
    return {
      remove: [agent.command, ['mcp', 'remove', 'fuli']],
      add: [agent.command, ['mcp', 'add', 'fuli', '--', ...mcpArgs]]
    };
  }
  if (agent.id === 'claude-code') {
    return {
      remove: [agent.command, ['mcp', 'remove', '--scope', 'user', 'fuli']],
      add: [agent.command, ['mcp', 'add', '--scope', 'user', 'fuli', '--', ...mcpArgs]]
    };
  }
  throw new TypeError(`Unsupported agent: ${agent.id}`);
}

export function connectAgent(agent, context, { runCommand = defaultRunCommand } = {}) {
  const commands = buildAgentCommands(agent, context);
  runCommand(...commands.remove);
  const result = runCommand(...commands.add);
  if (result?.status !== 0) {
    throw new Error(`Could not connect ${agent.label} to Fuli`);
  }
  return { id: agent.id, label: agent.label, status: 'connected' };
}

export function defaultCommandExists(command, platform = process.platform) {
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'ignore'
  });
  return result.status === 0;
}

function defaultRunCommand(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe'
  });
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
