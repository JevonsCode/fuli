import { existsSync } from 'node:fs';

import { createLauncher, defaultExtensionsDirectory } from './vendor/agent-session-launcher/index.mjs';

const COMPONENT = 'agent-session-launcher';
// classify, clients and inspect only plan; none opens a client.
const TIMEOUT_MS = 8000;

// FULI's port to agent-session-launcher, read-only in this stage: it never
// calls `open` (rec#11 D-79). Every answer is { status: 'available', ... } or
// { status: 'unavailable', reason }; on 'unavailable' the caller keeps FULI's
// own behaviour. A launcher error about one request (for example an ID the
// client does not accept) is { status: 'refused', code }.
//
// executables: agentKitExecutables().
// configPath: the host configuration FULI generates (launcher-host-config.js),
// passed only when it exists.
export function createSessionLauncherPort({
  executables,
  configPath = null,
  extensionsDir = defaultExtensionsDirectory()
}) {
  async function withLauncher({ download = false } = {}, call) {
    const executable = download ? await executables.ensure(COMPONENT) : await executables.resolve(COMPONENT);
    if (executable.status !== 'available') return executable;
    const launcher = createLauncher({ executable: executable.path, timeoutMs: TIMEOUT_MS, extensionsDir,
      ...(configPath && existsSync(configPath) ? { configPath } : {}) });
    try {
      return { status: 'available', ...await call(launcher) };
    } catch (error) {
      // Not this request's fault: the executable, its answer or the host
      // configuration. FULI falls back as if there were no launcher.
      if (UNAVAILABLE.has(error?.code)) return { status: 'unavailable', reason: `${error.code}: ${error.message}` };
      return { status: 'refused', code: error?.code ?? 'internal_error' };
    }
  }

  return {
    // The launcher client ID for a source label, refined only by Claude's
    // non-secret entry point signal.
    classify: (source, { claudeEntrypoint } = {}) => withLauncher({}, async (launcher) => ({
      client: await launcher.classify(source, claudeEntrypoint ? { claudeEntrypoint } : {})
    })),
    // download: fetch the pinned executable when it is missing (a console request, never a hook).
    clients: ({ download } = {}) => withLauncher({ download }, async (launcher) => ({
      clients: (await launcher.clients()).clients
    })),
    inspect: (target) => withLauncher({}, async (launcher) => await launcher.inspect(target))
  };
}

// `unknown_outcome` included: these calls only plan, but FULI never repeats a
// call that timed out (the component's rule for every action).
const UNAVAILABLE = new Set(['unavailable', 'invalid_executable', 'invalid_response', 'unknown_outcome',
  'invalid_configuration', 'invalid_timeout']);
