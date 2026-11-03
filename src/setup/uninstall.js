import { isAbsolute, relative } from 'node:path';

import { stopLocalRuntime } from '../local-runtime/lifecycle.js';
import { detectAgents } from '../agent-kits/client-detection.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { resolveSetupPaths } from './paths.js';

// The clients agent-installer finds FULI in. Without agent-installer FULI
// cannot remove itself from any client: the plan says why and names none.
export async function planLocalUninstall(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  detect = (paths) => detectAgents(agentKitPorts(paths, { env }).clientInstaller)
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const detection = await detect(paths);
  if (detection.status !== 'available') {
    return { paths, agents: [], clientDetection: { status: 'unavailable', reason: detection.reason, message: CLIENT_COMPONENT_UNAVAILABLE } };
  }
  return { paths, agents: detection.agents.filter(({ integrationStatus }) => integrationStatus !== 'not_connected') };
}

export async function applyLocalUninstall(plan, dependencies = {}) {
  const stopRuntime = dependencies.stopRuntime ?? stopLocalRuntime;
  let runtime;

  try {
    runtime = await stopRuntime({
      paths: plan.paths,
      port: dependencies.port,
      env: dependencies.env ?? process.env
    });
  } catch (error) {
    runtime = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Could not stop the local runtime'
    };
  }

  const installer = plan.agents.length
    ? dependencies.clientInstaller ?? agentKitPorts(plan.paths, { env: dependencies.env ?? process.env }).clientInstaller
    : null;
  const agents = [];
  for (const agent of plan.agents) agents.push(await removeAgent(installer, agent));

  const partial = runtime.status !== 'stopped' || Boolean(plan.clientDetection) ||
    agents.some(({ status }) => status === 'partial');
  return {
    status: partial ? 'partial' : 'ready',
    runtime,
    agents,
    ...(plan.clientDetection ? { clientDetection: plan.clientDetection } : {}),
    data: { status: 'preserved', path: plan.paths.dataDir },
    removal: removalTarget(plan.paths)
  };
}

// agent-installer backs up each file before it removes FULI's entries, and
// leaves a Skill the person changed (a problem names it).
async function removeAgent(installer, agent) {
  const removed = (status, errors = []) => ({ id: agent.id, label: agent.label, status, ...(errors.length ? { errors } : {}) });
  let answer;
  try {
    answer = await installer.remove([agent.id]);
  } catch (error) {
    return removed('partial', [error instanceof Error ? error.message : 'Agent disconnect failed']);
  }
  if (answer.status !== 'available') return removed('partial', [CLIENT_COMPONENT_UNAVAILABLE]);
  const client = answer.clients.find(({ id }) => id === agent.id);
  if (client?.problems.length) return removed('partial', client.problems);
  return removed(client?.changes.length ? 'disconnected' : 'not_connected');
}

// How the remaining program files are removed. A portable folder is deleted
// as a whole, which would also delete a data directory kept inside it.
export function removalTarget(paths) {
  if (!paths.portableRoot) return { kind: 'npm_global' };
  const local = relative(paths.portableRoot, paths.dataDir);
  return { kind: 'portable_folder', path: paths.portableRoot,
    // Compare the first path segment: a folder named '..data' is still inside.
    dataInside: !isAbsolute(local) && local.split(/[\\/]/)[0] !== '..' };
}
