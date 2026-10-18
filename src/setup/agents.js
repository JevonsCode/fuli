import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentAdapters, agentAdapter } from './agents/registry.js';

export function discoverAgents({ platform = process.platform, env = process.env, homeDir = homedir(),
  cwd = process.cwd(), includeUnavailable = false, fileExists = existsSync, commandExists = (command) => defaultCommandExists(command, platform) } = {}) {
  const environment = { platform, env, homeDir, cwd, includeUnavailable, fileExists, commandExists,
    pathApi: platform === 'win32' ? path.win32 : path.posix };
  return agentAdapters.map((adapter) => adapter.detect(environment)).filter(Boolean);
}
export function connectAgent(agent, context, dependencies = {}) {
  return agentAdapter(agent.id).connect(agent, context, dependencies);
}
export function disconnectAgent(agent, dependencies = {}) {
  return agentAdapter(agent.id).disconnect(agent, dependencies);
}
export function defaultCommandExists(command, platform = process.platform) {
  const result = spawnSync(platform === 'win32' ? 'where.exe' : 'which', [command], {
    encoding: 'utf8', windowsHide: true, stdio: 'ignore'
  });
  return result.status === 0;
}
