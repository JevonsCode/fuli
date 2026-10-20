import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { GraphitiProviderClient } from '../graphiti/provider-client.js';
import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { createRuntimeLeaseClient } from '../adaptive-runtime/lease-client.js';
import { createWorkerPlanHost, workerRuntimeBindingKey } from '../graphiti/worker-plan-host.js';
import { createCodexAcpWorkerAdapter } from '../agents/codex/acp-worker.js';
import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from '../graphiti/capture-session-pause.js';

const fields = new Set(['personalSpaceId', 'personalProjectId', 'executorId', 'application',
  'projectPath', 'adapterPath', 'codexPath', 'codexHome', 'leaseExecutor']);
const invalid = () => new TypeError('Invalid trusted worker runtime bindings');
const within = (parent, child) => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

// Local-only configuration. Never derive a path from the Provider directory or
// the model-facing coordination result. This does not log in or alter trust.
export async function createWorkerPlanRuntime({ runtimeConfigPath, workerRuntimeBindings,
  provider, leases, adapterFactory = createCodexAcpWorkerAdapter, attemptOptions, env = process.env }) {
  if (!(workerRuntimeBindings instanceof Map)) throw invalid();
  const bindings = new Map();
  for (const [key, input] of workerRuntimeBindings) {
    if (!input || Object.keys(input).some(name => !fields.has(name)) || input.application !== 'codex' ||
        ['personalSpaceId', 'personalProjectId', 'executorId'].some(name => typeof input[name] !== 'string' || !input[name].trim()) ||
        typeof input.leaseExecutor !== 'boolean' ||
        key !== workerRuntimeBindingKey(input.personalSpaceId, input.personalProjectId, input.executorId)) throw invalid();
    const paths = {};
    for (const name of ['projectPath', 'adapterPath', 'codexPath', 'codexHome']) {
      if (typeof input[name] !== 'string' || !isAbsolute(input[name])) throw invalid();
      paths[name] = await realpath(input[name]).catch(() => { throw invalid(); });
      const info = await stat(paths[name]);
      if (['projectPath', 'codexHome'].includes(name) ? !info.isDirectory() : !info.isFile()) throw invalid();
    }
    if (relative(await realpath(homedir()), paths.codexHome) === '') throw invalid();
    for (const daily of [join(homedir(), '.codex'), env.CODEX_HOME].filter(Boolean)) {
      if (within(await realpath(daily).catch(() => daily), paths.codexHome)) throw invalid();
    }
    bindings.set(key, { projectPath: paths.projectPath, leaseExecutor: input.leaseExecutor,
      adapter: adapterFactory({ ...paths, runtimeConfigPath }) });
  }
  const config = provider ? null : readGraphRuntimeConfig(runtimeConfigPath);
  const localLeases = leases ?? createRuntimeLeaseClient({ runtimeConfigPath });
  // Workers record nothing while the session that started them is paused, and
  // none starts or prompts while FULI is off for it (rec#5 C3b); a state that
  // cannot be read counts as off.
  const sessionPauses = new SessionCapturePauseStore(sessionCapturePausePathForRuntime(runtimeConfigPath));
  const host = createWorkerPlanHost({ provider: provider ?? new GraphitiProviderClient({
    baseUrl: config.personal.providerUrl, accessToken: config.personal.accessToken }),
  leases: localLeases, workerRuntimeBindings: bindings, attemptOptions: { ...attemptOptions,
    linkCaptureSession: (child, parent) => sessionPauses.link(child, parent),
    sessionFuliOff: sessionId => { try { return sessionPauses.state(sessionId).stopped; } catch { return true; } } } });
  return { host, async close() { await host.close(); if (!leases) await localLeases.close(); } };
}
