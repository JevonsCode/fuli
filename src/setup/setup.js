import { backupAgentConfig } from './config-backup.js';
import { totalmem } from 'node:os';
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
import {
  DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
  adaptiveRuntimeSettingsWithOverrides,
  readAdaptiveRuntimeSettings
} from '../adaptive-runtime/settings.js';

export function planLocalSetup(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  discover = discoverAgents,
  inspectInstallations = inspectAgentInstallations,
  readSettings = readRuntimeSettings,
  readAdaptiveSettings = readAdaptiveRuntimeSettings,
  platform = process.platform,
  hostTotalMemory = totalmem,
  nodePath = process.execPath
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const savedRuntimeSettings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const runtimeSettings = runtimeSettingsWithOverrides(savedRuntimeSettings, {
    consolePort: options.port,
    graphRuntimeMode: options.runtimeMode
  });
  const savedAdaptiveRuntimeSettings = paths.adaptiveRuntimeSettingsPath
    ? readAdaptiveSettings(paths.adaptiveRuntimeSettingsPath)
    : DEFAULT_ADAPTIVE_RUNTIME_SETTINGS;
  const adaptiveRuntimeSettings = adaptiveRuntimeSettingsWithOverrides(
    savedAdaptiveRuntimeSettings,
    { enabled: options.adaptiveMemory ?? null }
  );
  const discovered = options.skipAgents ? [] : discover({ env });
  const agents = options.codexOnly
    ? discovered.filter(({ id }) => id === 'codex')
    : discovered;
  return {
    paths,
    runtimeSettings,
    runtimeModeRecommendation: graphRuntimeModeRecommendation({
      platform,
      hostTotalBytes: hostTotalMemory()
    }),
    adaptiveRuntimeSettings,
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

function graphRuntimeModeRecommendation({ platform, hostTotalBytes }) {
  const lowMemoryMac = platform === 'darwin' &&
    Number.isFinite(hostTotalBytes) &&
    hostTotalBytes <= 16 * 1024 ** 3;
  return {
    recommendedMode: lowMemoryMac ? 'native' : 'container',
    reason: lowMemoryMac ? 'low-memory-mac' : 'default',
    hostTotalBytes
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
    runtimeMode: runtimeSettings.graphRuntimeMode,
    personalOnly: options.personalOnly,
    memoryProfile: options.memoryProfile,
    adaptiveRuntimeSettings: plan.adaptiveRuntimeSettings,
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
