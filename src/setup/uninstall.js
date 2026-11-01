import { isAbsolute, relative } from 'node:path';

import { stopLocalRuntime } from '../local-runtime/lifecycle.js';
import { backupAgentConfig } from './config-backup.js';
import { detectAgents } from '../agent-kits/client-detection.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { agentTargets, disconnectAgent } from './agents.js';
import { resolveSetupPaths } from './paths.js';
import { removeBundledSkill } from './session-skill.js';

// The clients agent-installer finds FULI in. Without it, every client FULI
// writes: each writer removes only FULI's entries and leaves an absent file alone.
export async function planLocalUninstall(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  targets = agentTargets,
  detect = (paths, list) => detectAgents(agentKitPorts(paths, { env }).clientInstaller, list)
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const all = targets({ env, dataDir: paths.dataDir });
  const detection = await detect(paths, all);
  const agents = detection.status === 'available'
    ? detection.agents.filter(({ integrationStatus }) => integrationStatus !== 'not_connected') : all;
  return { paths, agents };
}

export async function applyLocalUninstall(plan, dependencies = {}) {
  const stopRuntime = dependencies.stopRuntime ?? stopLocalRuntime;
  const backupConfig = dependencies.backupConfig ?? backupAgentConfig;
  const disconnect = dependencies.disconnect ?? disconnectAgent;
  const removeSkill = dependencies.removeSkill ?? removeBundledSkill;
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

  const agents = plan.agents.map((agent) => {
    const errors = [];
    let backupPath = null;
    let connection;
    const skills = [];
    try {
      backupPath = backupConfig(agent, { backupDir: plan.paths.backupDir });
      connection = disconnect(agent);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Agent disconnect failed');
      connection = { status: 'failed' };
    }

    // A client without a Skill path (e.g. no session command Skill on Codex) has nothing to remove there.
    for (const [skillPath, sourcePath] of [
      [agent.skillPath, plan.paths.sessionSkillPath],
      [agent.projectSkillPath, plan.paths.projectSkillPath],
      [agent.reviewSkillPath, plan.paths.reviewSkillPath],
      [agent.operationSkillPath, plan.paths.operationSkillPath],
      [agent.sessionCommandSkillPath, plan.paths.sessionCommandSkillPath]
    ].filter(([skillPath]) => skillPath)) {
      try {
        skills.push(removeSkill({ ...agent, skillPath }, { sourcePath }));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Skill removal failed');
      }
    }

    return {
      id: agent.id,
      label: agent.label,
      status: errors.length ? 'partial' : connection.status,
      backupPath,
      skills,
      ...(errors.length ? { errors } : {})
    };
  });

  const partial = runtime.status !== 'stopped' ||
    agents.some(({ status }) => status === 'partial');
  return {
    status: partial ? 'partial' : 'ready',
    runtime,
    agents,
    data: { status: 'preserved', path: plan.paths.dataDir },
    removal: removalTarget(plan.paths)
  };
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
