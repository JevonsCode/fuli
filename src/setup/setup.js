import { backupAgentConfig } from './config-backup.js';
import { inspectAgentInstallations } from './agent-installation-status.js';
import { connectAgent, discoverAgents } from './agents.js';
import { resolveSetupPaths } from './paths.js';
import { ensureGraphRuntime } from './graph-runtime.js';
import { installSessionSkill } from './session-skill.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  readRuntimeSettings,
  runtimeSettingsWithOverrides
} from '../system/runtime-settings.js';

export function planLocalSetup(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  discover = discoverAgents,
  inspectInstallations = inspectAgentInstallations,
  readSettings = readRuntimeSettings,
  nodePath = process.execPath
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const savedRuntimeSettings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const runtimeSettings = runtimeSettingsWithOverrides(savedRuntimeSettings, {
    consolePort: options.port
  });
  const discovered = options.skipAgents ? [] : discover({ env });
  const agents = options.codexOnly
    ? discovered.filter(({ id }) => id === 'codex')
    : discovered;
  return {
    paths,
    runtimeSettings,
    agents: inspectInstallations(agents, {
      nodePath,
      mcpServerPath: paths.mcpServerPath,
      runtimeConfigPath: paths.graphRuntimeConfigPath,
      sessionSkillPath: paths.sessionSkillPath,
      projectSkillPath: paths.projectSkillPath,
      reviewSkillPath: paths.reviewSkillPath
    })
  };
}

export async function applyLocalSetup(plan, options, dependencies = {}) {
  const ensureRuntime = dependencies.ensureRuntime ?? ensureGraphRuntime;
  const backupConfig = dependencies.backupConfig ?? backupAgentConfig;
  const connect = dependencies.connect ?? connectAgent;
  const installSkill = dependencies.installSkill ?? installSessionSkill;
  const runtimeSettings = plan.runtimeSettings ?? runtimeSettingsWithOverrides(
    DEFAULT_RUNTIME_SETTINGS,
    { consolePort: options.port }
  );
  const runtime = await ensureRuntime({
    paths: plan.paths,
    personalSpaceName: options.personalSpaceName,
    port: runtimeSettings.ports.console,
    lan: runtimeSettings.lanAccess,
    runtimeSettings,
    personalOnly: options.personalOnly,
    noStart: options.noStart,
    env: dependencies.env ?? process.env,
    onProgress: dependencies.onProgress
  });
  const context = {
    nodePath: dependencies.nodePath ?? process.execPath,
    mcpServerPath: plan.paths.mcpServerPath,
    runtimeConfigPath: plan.paths.graphRuntimeConfigPath
  };
  const agents = [];

  for (const agent of plan.agents.filter(
    ({ available, selected }) => available && selected !== false
  )) {
    try {
      const backupPath = backupConfig(agent, { backupDir: plan.paths.backupDir });
      const connected = connect(agent, context);
      const skills = [
        installSkill(agent, {
          sourcePath: plan.paths.sessionSkillPath,
          backupDir: plan.paths.backupDir
        }),
        installSkill({ ...agent, skillPath: agent.projectSkillPath }, {
          sourcePath: plan.paths.projectSkillPath,
          backupDir: plan.paths.backupDir
        }),
        installSkill({ ...agent, skillPath: agent.reviewSkillPath }, {
          sourcePath: plan.paths.reviewSkillPath,
          backupDir: plan.paths.backupDir
        })
      ];
      agents.push({ ...connected, backupPath, skills });
    } catch (error) {
      agents.push({
        id: agent.id,
        label: agent.label,
        status: 'failed',
        message: error instanceof Error ? error.message : 'Agent connection failed'
      });
    }
  }

  return {
    status: agents.some(({ status }) => status === 'failed') ? 'partial' : 'ready',
    runtime,
    agents
  };
}
