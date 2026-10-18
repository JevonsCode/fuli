import { connectCodex, disconnectCodex } from '../../codex-config.js';
import { adaptAgentForReviewSkill } from '../../review-skill-adapters.js';
import { existingFuliArgs, replaceFuliTable } from '../../codex-config.js';
import { installedToolProfile } from '../../installed-tool-profile.js';
import { hasCodexTomlHookDefinitions, hasCurrentCodexLifecycleHooks, hasCurrentCodexTomlLifecycleHooks, withCodexTomlLifecycleHooks } from '../../../agents/codex/lifecycle-hooks.js';

export const adapter = {
  id: 'codex',
  detect({ env, homeDir, pathApi, fileExists, commandExists }) {
    const skillName = 'capturing-session-knowledge';
    const projectSkillName = 'grilling-project';
    const operationSkillName = 'operating-fuli';
    const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME : pathApi.join(homeDir, '.codex');
    return adaptAgentForReviewSkill({
      id: 'codex',
      label: 'Codex',
      command: 'codex',
      configPath: pathApi.join(codexHome, 'config.toml'),
      hooksPath: pathApi.join(codexHome, 'hooks.json'),
      globalInstructionsPath: pathApi.join(codexHome, 'AGENTS.md'),
      globalInstructionsOverridePath: pathApi.join(codexHome, 'AGENTS.override.md'),
      skillPath: pathApi.join(homeDir, '.agents', 'skills', skillName),
      projectSkillPath: pathApi.join(homeDir, '.agents', 'skills', projectSkillName),
      operationSkillPath: pathApi.join(homeDir, '.agents', 'skills', operationSkillName),
      available: Boolean(commandExists('codex') || fileExists(pathApi.join(codexHome, 'config.toml')))
    }, { homeDir, pathApi });
  },
  connect(agent, context, dependencies = {}) { return (dependencies.connectCodexConfig ?? connectCodex)(agent, context); },
  disconnect(agent, dependencies = {}) { return (dependencies.disconnectCodexConfig ?? disconnectCodex)(agent); },
  status(agent, context, readers) {
    const current = readers.readText(agent.configPath);
    const present = /^\s*\[mcp_servers\.(?:fuli|"fuli"|'fuli')]/m.test(current);
    let registration;
    try {
      const args = [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath,
        '--source-application', 'codex', '--tool-profile', installedToolProfile(existingFuliArgs(current), context.toolProfile)];
      const expected = replaceFuliTable(current, { command: context.nodePath, args });
      const normalized = hasCodexTomlHookDefinitions(current) ? withCodexTomlLifecycleHooks(expected, { context }) : expected;
      registration = { present, current: present && normalized.replaceAll('\r\n', '\n').trim() === current.replaceAll('\r\n', '\n').trim() };
    } catch { registration = { present, current: false }; }
    return { registration,
      bootstrap: readers.bootstrapCurrent(agent, context, readers),
      ...(agent.hooksPath ? { lifecycleHooks: hasCodexTomlHookDefinitions(current)
        ? hasCurrentCodexTomlLifecycleHooks(current, { context })
        : hasCurrentCodexLifecycleHooks(readers.readJson(agent.hooksPath), { context }) } : {}) };
  }
};
