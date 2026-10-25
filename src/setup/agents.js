import { dirname } from 'node:path';
import { resolveSetupPaths } from './paths.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { configuredAgentAdapters, agentAdapter } from './agents/registry.js';
import { platformPath } from '../system/platform-path.js';

// A client's own `--version` answer, read only where a writer needs it (OpenCode
// V1 and V2 take different plugins). The console observes clients repeatedly,
// so one answer is reused for a while instead of starting the client each time.
const VERSION_TIMEOUT_MS = 5_000;
const VERSION_REUSE_MS = 60_000;
const versions = new Map();

export function discoverAgents({ platform = process.platform, env = process.env, homeDir = homedir(),
  cwd = process.cwd(), dataDir: requestedDataDir, includeUnavailable = false, fileExists = existsSync,
  commandExists = (command) => defaultCommandExists(command, platform),
  commandVersion = (command) => commandExists(command) ? defaultCommandVersion(command, platform) : null } = {}) {
  const environment = { platform, env, homeDir, cwd, includeUnavailable, fileExists, commandExists, commandVersion,
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

// The first x.y.z the command prints for --version, with or without a leading
// v (OpenCode 2.1.4 prints `opencode v2.1.4`), or null. `command` is a
// descriptor pack's command name (a fixed lowercase word); Windows needs the
// shell to run an npm .cmd shim. Reuse is per PATH, which picks the binary.
const VERSION_TEXT = /(?:^|[^\w.])v?(\d+\.\d+\.\d+)/;
function defaultCommandVersion(command, platform, now = Date.now()) {
  const key = `${command}\0${process.env.PATH ?? ''}`;
  const reused = versions.get(key);
  if (reused && now - reused.at < VERSION_REUSE_MS) return reused.version;
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: VERSION_TIMEOUT_MS,
    shell: platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const version = result.status === 0 ? VERSION_TEXT.exec(result.stdout ?? '')?.[1] ?? null : null;
  versions.set(key, { version, at: now });
  return version;
}
