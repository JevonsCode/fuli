import { backupAgentConfig } from './config-backup.js';
import { connectAgent } from './agents.js';
import { inspectAgentInstallations } from './agent-installation-status.js';
import { installSessionSkill } from './session-skill.js';

// Shared by CLI setup and the local console. Backup always precedes configuration writes.
export async function installAgent(agent, context, paths, {
  backupConfig = backupAgentConfig, connect = connectAgent, installSkill = installSessionSkill,
  inspectInstallations = inspectAgentInstallations
} = {}) {
  let backupPath;
  let connected;
  const skills = [];
  try {
    backupPath = backupConfig(agent, { backupDir: paths.backupDir });
    connected = connect(agent, context);
    for (const [target, sourcePath] of [
      [agent, paths.sessionSkillPath],
      [{ ...agent, skillPath: agent.projectSkillPath }, paths.projectSkillPath],
      [{ ...agent, skillPath: agent.reviewSkillPath }, paths.reviewSkillPath],
      [{ ...agent, skillPath: agent.operationSkillPath }, paths.operationSkillPath]
    ].filter(([target]) => target.skillPath)) {
      skills.push(await installSkill(target, {
        sourcePath,
        backupDir: paths.backupDir
      }));
    }
    const [inspected] = inspectInstallations
      ? inspectInstallations([agent], context)
      : [];
    if (inspected && inspected.integrationStatus !== 'connected') {
      const failedChecks = Object.entries(inspected.integrationDetails ?? {})
        .filter(([, state]) => state !== 'current')
        .map(([component, state]) => `${component}=${state}`);
      return {
        ...connected,
        status: 'partial',
        backupPath,
        skills,
        selfCheck: {
          status: 'failed',
          details: inspected.integrationDetails
        },
        message: `Self-check failed (${failedChecks.join(', ') || inspected.integrationStatus})`
      };
    }
    return {
      ...connected,
      backupPath,
      skills,
      ...(inspected
        ? {
            selfCheck: {
              status: 'passed',
              details: inspected.integrationDetails
            }
          }
        : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent connection failed';
    return connected
      ? {
          ...connected,
          status: 'partial',
          backupPath,
          skills,
          message
        }
      : {
          id: agent.id,
          label: agent.label,
          status: 'failed',
          message
        };
  }
}
