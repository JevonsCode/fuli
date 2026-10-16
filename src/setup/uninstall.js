import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import { stopLocalRuntime } from '../local-runtime/lifecycle.js';
import { backupAgentConfig } from './config-backup.js';
import { disconnectAgent, discoverAgents } from './agents.js';
import { resolveSetupPaths } from './paths.js';
import { removeBundledSkill } from './session-skill.js';

export function planLocalUninstall(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  discover = discoverAgents,
  fileExists = existsSync
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const agents = discover({ env }).filter((agent) => (
    agent.available ||
    (agent.configPath && fileExists(agent.configPath)) ||
    (agent.globalInstructionsPath && fileExists(agent.globalInstructionsPath)) ||
    (agent.globalInstructionsOverridePath &&
      fileExists(agent.globalInstructionsOverridePath)) ||
    (agent.skillPath && fileExists(agent.skillPath)) ||
    (agent.projectSkillPath && fileExists(agent.projectSkillPath)) ||
    (agent.reviewSkillPath && fileExists(agent.reviewSkillPath)) ||
    (agent.operationSkillPath && fileExists(agent.operationSkillPath))
  ));
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

    for (const [skillPath, sourcePath] of [
      [agent.skillPath, plan.paths.sessionSkillPath],
      [agent.projectSkillPath, plan.paths.projectSkillPath],
      [agent.reviewSkillPath, plan.paths.reviewSkillPath],
      [agent.operationSkillPath, plan.paths.operationSkillPath]
    ]) {
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
