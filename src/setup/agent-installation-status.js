import { existsSync, readFileSync } from 'node:fs';

import { replaceFuliTable } from './codex-config.js';
import { isCodexBootstrapCurrent } from './codex-bootstrap.js';
import { hasCurrentClaudeCodeHooks } from './claude-code-config.js';
import { isSessionSkillCurrent } from './session-skill.js';
import { readJsonFile } from '../storage/json-file.js';

export function inspectAgentInstallations(agents, context, {
  readText = defaultReadText,
  readJson = defaultReadJson,
  fileExists = existsSync,
  skillCurrent = isSessionSkillCurrent,
  bootstrapCurrent = isCodexBootstrapCurrent
} = {}) {
  return agents.map((agent) => {
    const registration = inspectRegistration(agent, context, { readText, readJson });
    const skillPairs = [
      [context.sessionSkillPath, agent.skillPath],
      [context.projectSkillPath, agent.projectSkillPath],
      [context.reviewSkillPath, agent.reviewSkillPath]
    ];
    const skillsPresent = skillPairs.some(([, targetPath]) => fileExists(targetPath));
    const skillsCurrent = skillPairs.every(
      ([sourcePath, targetPath]) => skillCurrent(sourcePath, targetPath)
    );
    const codexBootstrapCurrent = agent.id !== 'codex' || bootstrapCurrent(
      agent,
      context,
      { fileExists, readText }
    );
    const claudeLifecycleCurrent = agent.id !== 'claude-code' ||
      hasCurrentClaudeCodeHooks(readJson(agent.settingsPath));

    let integrationStatus = 'not_connected';
    if (
      registration.current
      && skillsCurrent
      && codexBootstrapCurrent
      && claudeLifecycleCurrent
    ) {
      integrationStatus = 'connected';
    }
    else if (registration.present || skillsPresent) integrationStatus = 'update_available';

    return {
      ...agent,
      integrationStatus,
      integrationDetails: {
        mcp: registration.current ? 'current' : registration.present ? 'outdated' : 'missing',
        skills: skillsCurrent ? 'current' : skillsPresent ? 'outdated' : 'missing',
        ...(agent.id === 'codex'
          ? { bootstrap: codexBootstrapCurrent ? 'current' : 'outdated' }
          : {}),
        ...(agent.id === 'claude-code'
          ? { lifecycleHooks: claudeLifecycleCurrent ? 'current' : 'outdated' }
          : {})
      }
    };
  });
}

function inspectRegistration(agent, context, readers) {
  const expected = {
    command: context.nodePath,
    args: [
      context.mcpServerPath,
      '--runtime-config',
      context.runtimeConfigPath,
      '--source-application',
      agent.id === 'claude-code' ? 'claude_code' : agent.id
    ]
  };
  try {
    if (agent.id === 'codex') {
      const current = readers.readText(agent.configPath);
      const present = /^\s*\[mcp_servers\.(?:fuli|"fuli"|'fuli')]/m.test(current);
      return {
        present,
        current: present && normalizeText(replaceFuliTable(current, expected)) ===
          normalizeText(current)
      };
    }

    const config = readers.readJson(agent.configPath);
    const server = config?.mcpServers?.fuli;
    const present = Boolean(server && typeof server === 'object' && !Array.isArray(server));
    return {
      present,
      current: present &&
        server.command === expected.command &&
        sameStrings(server.args, expected.args) &&
        (agent.id !== 'claude-code' || server.alwaysLoad === true)
    };
  } catch {
    return { present: false, current: false };
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function normalizeText(value) {
  return value.replaceAll('\r\n', '\n').trim();
}

function defaultReadText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function defaultReadJson(path) {
  return readJsonFile(path, {});
}
