import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The DeepSeek Harness plugin people install from DSH's plugin list
// (`dsh plugin add`), before or without connecting DSH from FULI's console.
// It ships no FULI code: it finds the FULI installed on this computer and
// runs the bundle that FULI writes for DSH (`<FULI data>/agent-kits/dsh-bundle`,
// src/agents/dsh/bundle.js), so its behaviour always matches that FULI:
// - FULI's lifecycle plugin from the bundle's index.js (the task entry at a
//   turn's first step, the task close at its completed end);
// - FULI's MCP server, from the `fuli-mcp` row of the bundle's
//   cordis.patch.yml, through DSH's own @deepseek-ai/dsh-mcp-client.
// When this profile already loads FULI's own bundle (`fuli-dsh`, which the
// FULI console links into each profile it connects), the connector stays
// idle, so nothing runs twice. That is read from what DSH started this
// profile with (`profileContext.startedBundles`), never from shared files:
// another profile being connected says nothing about this one. Without FULI
// it only logs one line.
// Node built-ins only; every failure leaves DSH running.

export const name = 'fuli-connector';
export const inject = ['agents'];

const MCP_ROW = 'fuli-mcp';
// The package FULI's console links into a profile (src/agents/dsh/bundle.js).
const FULI_BUNDLE = 'fuli-dsh';

export async function apply(ctx, _config, { env = process.env, platform = process.platform, homeDir = homedir(),
  importModule = (specifier) => import(specifier) } = {}) {
  const log = (level, text) => ctx.logger?.[level]?.(`fuli-connector: ${text}`);
  try {
    if (startedBundles(ctx).includes(FULI_BUNDLE)) {
      log('info', "this profile already loads FULI's own bundle (connected from the FULI console); the connector stays idle.");
      return;
    }
    const bundle = join(fuliDataDir(env, platform, homeDir), 'agent-kits', 'dsh-bundle');
    if (!existsSync(join(bundle, 'index.js'))) {
      log('warn', 'no FULI found on this computer (DeepSeek Harness needs FULI 0.27.0 or newer). '
        + 'Install FULI from https://github.com/JevonsCode/fuli and start it once.');
      return;
    }
    const lifecycle = await importModule(pathToFileURL(join(bundle, 'index.js')).href);
    lifecycle.apply(ctx);
    const mcp = mcpConfig(readFileSync(join(bundle, 'cordis.patch.yml'), 'utf8'));
    // Awaited as a patch row is: the first request already lists FULI's tools.
    if (mcp) await ctx.plugin(await importModule('@deepseek-ai/dsh-mcp-client'), mcp);
    log('info', `connected to the FULI data at ${bundle}`);
  } catch (error) {
    log('warn', `FULI could not be loaded (${error?.message ?? error}); DeepSeek Harness runs without it.`);
  }
}

// The bundle packages DSH started this profile with; none outside a profile
// DSH launched (an embedding host), where FULI's console never links its own.
function startedBundles(ctx) {
  let profile;
  try {
    profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : ctx.profileContext;
  } catch {
    profile = undefined;
  }
  return Array.isArray(profile?.startedBundles) ? profile.startedBundles : [];
}

// FULI's data directory: `FULI_DATA_DIR`, or its default, as
// src/setup/paths.js defaultDataDir decides it (a test keeps the two equal).
function fuliDataDir(env, platform, homeDir) {
  const set = nonEmpty(env.FULI_DATA_DIR);
  if (set) return set;
  if (platform === 'win32') return join(nonEmpty(env.LOCALAPPDATA) ?? join(homeDir, 'AppData', 'Local'), 'Fuli');
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'Fuli');
  return join(nonEmpty(env.XDG_DATA_HOME) ?? join(homeDir, '.local', 'share'), 'fuli');
}

// The bundle writes each patch row as one JSON flow mapping.
function mcpConfig(patch) {
  for (const line of patch.split('\n')) {
    const text = line.trim().replace(/^- /, '');
    if (!text.startsWith('{')) continue;
    try {
      const row = JSON.parse(text);
      if (row?.id === MCP_ROW && row.config) return row.config;
    } catch {
      // Not a JSON row.
    }
  }
  return null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
