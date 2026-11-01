import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentKitExecutables } from '../src/agent-kits/executables.js';

// The real pinned executables of the shared client components for this
// platform, downloaded once per machine into a test cache and verified
// against their pins. Null (the caller skips) when they cannot be had, for
// example offline. A developer testing an unreleased build points
// FULI_AGENT_INSTALLER (or FULI_AGENT_SESSION_LAUNCHER) at it, as FULI does.
const CACHE = join(tmpdir(), 'fuli-agent-kits-test-cache');
const OVERRIDES = ['FULI_AGENT_INSTALLER', 'FULI_AGENT_SESSION_LAUNCHER'];

export async function realAgentKitExecutable(component) {
  const env = Object.fromEntries(OVERRIDES.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  const found = await agentKitExecutables({ nativeRuntimeDir: CACHE, env }).ensure(component);
  return found.status === 'available' ? found.path : null;
}

// Points every home and configuration directory a client component reads at
// a new temporary directory for this test process, and drops the variables
// that move a client's configuration elsewhere: the real executables then
// never see the person's own client configuration. Restored after the test.
const HOME_VARIABLES = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];
const CLIENT_VARIABLES = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'KIRO_HOME', 'QWEN_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT'];

export function isolateHomeEnvironment(t) {
  const home = mkdtempSync(join(tmpdir(), 'fuli-agent-kits-home-'));
  const saved = Object.fromEntries([...HOME_VARIABLES, ...CLIENT_VARIABLES].map((name) => [name, process.env[name]]));
  const values = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share') };
  Object.assign(process.env, values);
  for (const name of CLIENT_VARIABLES) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { home, env: { ...process.env } };
}
