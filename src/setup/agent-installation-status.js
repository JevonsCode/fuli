import { existsSync, readFileSync } from 'node:fs';
import { agentAdapter } from './agents/registry.js';
import { isCodexBootstrapCurrent } from './codex-bootstrap.js';
import { isSessionSkillCurrent } from './session-skill.js';
import { parseMcpJson } from './agents/json-mcp.js';
export function inspectAgentInstallations(agents, context, {
  readText = defaultReadText,
  readJson = defaultReadJson,
  fileExists = existsSync,
  skillCurrent = isSessionSkillCurrent,
  bootstrapCurrent = isCodexBootstrapCurrent
} = {}) {
  return agents.map((agent) => {
    const { registration, ...checks } = agentAdapter(agent.id).status(agent, context, {
      readText, readJson, fileExists, bootstrapCurrent
    });
    const skillPairs = [
      [context.sessionSkillPath, agent.skillPath],
      [context.projectSkillPath, agent.projectSkillPath],
      [context.reviewSkillPath, agent.reviewSkillPath],
      [context.operationSkillPath, agent.operationSkillPath]
    ].filter(([, targetPath]) => targetPath);
    const skillsPresent = skillPairs.some(([, targetPath]) => fileExists(targetPath));
    const skillsCurrent = skillPairs.every(
      ([sourcePath, targetPath]) => skillCurrent(sourcePath, targetPath)
    );
    let integrationStatus = 'not_connected';
    if (
      registration.current
      && skillsCurrent
      && Object.values(checks).every(Boolean)
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
        ...Object.fromEntries(Object.entries(checks).map(([key, current]) => [key, current ? 'current' : 'outdated']))
      }
    };
  });
}

function defaultReadText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function defaultReadJson(path, options) {
  try {
    return existsSync(path) ? parseMcpJson(readFileSync(path, 'utf8'), options) : {};
  } catch {
    return {};
  }
}
