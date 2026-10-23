import { dirname } from 'node:path';
import { resolveSetupPaths } from './paths.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { configuredAgentAdapters, agentAdapter } from './agents/registry.js';
import { platformPath } from '../system/platform-path.js';

export function discoverAgents({ platform = process.platform, env = process.env, homeDir = homedir(),
  cwd = process.cwd(), dataDir: requestedDataDir, includeUnavailable = false, fileExists = existsSync, commandExists = (command) => defaultCommandExists(command, platform) } = {}) {
  const environment = { platform, env, homeDir, cwd, includeUnavailable, fileExists, commandExists,
    pathApi: platformPath(platform) };
  const dataDir = resolveSetupPaths({ env, homeDir, platform, dataDir: requestedDataDir }).dataDir;
  return configuredAgentAdapters(dataDir).map((adapter) => adapter.detect(environment)).filter(Boolean);
}
export function connectAgent(agent, context, dependencies = {}) {
  return agentAdapter(agent.id, context.dataDir ?? (context.runtimeConfigPath ? dirname(context.runtimeConfigPath) : undefined)).connect(agent, context, dependencies);
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
