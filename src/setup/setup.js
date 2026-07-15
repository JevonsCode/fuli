import { backupAgentConfig } from './config-backup.js';
import { connectAgent, discoverAgents } from './agents.js';
import { resolveSetupPaths } from './paths.js';
import { ensureLocalRuntime } from './runtime.js';

export function planLocalSetup(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  discover = discoverAgents
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const agents = options.skipAgents ? [] : discover({ env });
  return { paths, agents };
}

export async function applyLocalSetup(plan, options, dependencies = {}) {
  const ensureRuntime = dependencies.ensureRuntime ?? ensureLocalRuntime;
  const backupConfig = dependencies.backupConfig ?? backupAgentConfig;
  const connect = dependencies.connect ?? connectAgent;
  const runtime = await ensureRuntime({
    paths: plan.paths,
    personalSpaceName: options.personalSpaceName,
    port: options.port,
    noStart: options.noStart
  });
  const context = {
    nodePath: dependencies.nodePath ?? process.execPath,
    mcpServerPath: plan.paths.mcpServerPath,
    dbPath: plan.paths.dbPath,
    personalSpaceName: options.personalSpaceName
  };
  const agents = [];

  for (const agent of plan.agents.filter(({ available }) => available)) {
    try {
      const backupPath = backupConfig(agent, { backupDir: plan.paths.backupDir });
      const connected = connect(agent, context);
      agents.push({ ...connected, backupPath });
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
