import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceFuliTable } from '../src/setup/codex-config.js';
import { inspectAgentInstallations } from '../src/setup/agent-installation-status.js';

const CONTEXT = Object.freeze({
  nodePath: 'C:/Runtime/node.exe',
  mcpServerPath: 'C:/Fuli/src/mcp-server.js',
  runtimeConfigPath: 'C:/Data/Fuli/graph-runtime.json',
  sessionSkillPath: 'C:/Fuli/skills/capturing-session-knowledge',
  projectSkillPath: 'C:/Fuli/skills/grilling-project',
  reviewSkillPath: 'C:/Fuli/skills/flreview'
});

const AGENTS = Object.freeze([
  {
    id: 'codex',
    label: 'Codex',
    configPath: 'C:/User/.codex/config.toml',
    globalInstructionsPath: 'C:/User/.codex/AGENTS.md',
    globalInstructionsOverridePath: 'C:/User/.codex/AGENTS.override.md',
    skillPath: 'C:/User/.agents/skills/capturing-session-knowledge',
    projectSkillPath: 'C:/User/.agents/skills/grilling-project',
    reviewSkillPath: 'C:/User/.agents/skills/flreview'
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: 'C:/User/.claude.json',
    settingsPath: 'C:/User/.claude/settings.json',
    skillPath: 'C:/User/.claude/skills/capturing-session-knowledge',
    projectSkillPath: 'C:/User/.claude/skills/grilling-project',
    reviewSkillPath: 'C:/User/.claude/skills/flreview'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: 'C:/User/.cursor/mcp.json',
    skillPath: 'C:/User/.cursor/skills/capturing-session-knowledge',
    projectSkillPath: 'C:/User/.cursor/skills/grilling-project',
    reviewSkillPath: 'C:/User/.cursor/skills/flreview'
  }
]);

test('setup distinguishes current, outdated, and missing Agent integrations', () => {
  const desiredArgs = [
    CONTEXT.mcpServerPath,
    '--runtime-config',
    CONTEXT.runtimeConfigPath,
    '--source-application',
    'codex'
  ];
  const currentCodex = replaceFuliTable('', {
    command: CONTEXT.nodePath,
    args: desiredArgs
  });
  const jsonConfigs = new Map([
    [AGENTS[1].configPath, {
      mcpServers: {
        fuli: {
          type: 'stdio',
          command: CONTEXT.nodePath,
          args: [CONTEXT.mcpServerPath, '--db', 'legacy.db']
        }
      }
    }]
  ]);
  const currentSkills = new Set([
    AGENTS[0].skillPath,
    AGENTS[0].projectSkillPath,
    AGENTS[0].reviewSkillPath,
    AGENTS[1].skillPath
  ]);
  const presentSkills = new Set(currentSkills);

  const inspected = inspectAgentInstallations(AGENTS, CONTEXT, {
    readText: (path) => path === AGENTS[0].configPath ? currentCodex : '',
    readJson: (path) => jsonConfigs.get(path) ?? {},
    fileExists: (path) => presentSkills.has(path),
    skillCurrent: (_sourcePath, targetPath) => currentSkills.has(targetPath),
    bootstrapCurrent: () => true
  });

  assert.deepEqual(
    inspected.map(({ integrationStatus }) => integrationStatus),
    ['connected', 'update_available', 'not_connected']
  );
});

test('a current JSON MCP registration and both current Skills count as connected', () => {
  const desiredArgs = [
    CONTEXT.mcpServerPath,
    '--runtime-config',
    CONTEXT.runtimeConfigPath,
    '--source-application',
    'cursor'
  ];
  const cursor = AGENTS[2];
  const [inspected] = inspectAgentInstallations([cursor], CONTEXT, {
    readJson: () => ({
      mcpServers: {
        fuli: {
          command: CONTEXT.nodePath,
          args: desiredArgs
        }
      }
    }),
    fileExists: () => true,
    skillCurrent: () => true
  });

  assert.equal(inspected.integrationStatus, 'connected');
});

test('Claude Code requires always-loaded Fuli plus task lifecycle hooks', () => {
  const claude = AGENTS[1];
  const desiredArgs = [
    CONTEXT.mcpServerPath,
    '--runtime-config',
    CONTEXT.runtimeConfigPath,
    '--source-application',
    'claude_code'
  ];
  const configs = new Map([
    [claude.configPath, {
      mcpServers: {
        fuli: {
          type: 'stdio',
          command: CONTEXT.nodePath,
          args: desiredArgs,
          alwaysLoad: true
        }
      }
    }],
    [claude.settingsPath, {
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: 'mcp_tool',
            server: 'fuli',
            tool: 'begin_task_context'
          }]
        }],
        Stop: [{
          hooks: [{
            type: 'mcp_tool',
            server: 'fuli',
            tool: 'verify_task_checkpoint'
          }]
        }]
      }
    }]
  ]);
  const [current] = inspectAgentInstallations([claude], CONTEXT, {
    readJson: (path) => configs.get(path) ?? {},
    fileExists: () => true,
    skillCurrent: () => true
  });
  assert.equal(current.integrationStatus, 'connected');
  assert.equal(current.integrationDetails.lifecycleHooks, 'current');

  configs.set(claude.settingsPath, {});
  const [outdated] = inspectAgentInstallations([claude], CONTEXT, {
    readJson: (path) => configs.get(path) ?? {},
    fileExists: () => true,
    skillCurrent: () => true
  });
  assert.equal(outdated.integrationStatus, 'update_available');
  assert.equal(outdated.integrationDetails.lifecycleHooks, 'outdated');
});

test('Codex requires a current global bootstrap in addition to MCP and Skills', () => {
  const codex = AGENTS[0];
  const currentConfig = replaceFuliTable('', {
    command: CONTEXT.nodePath,
    args: [
      CONTEXT.mcpServerPath,
      '--runtime-config',
      CONTEXT.runtimeConfigPath,
      '--source-application',
      'codex'
    ]
  });
  const [inspected] = inspectAgentInstallations([codex], CONTEXT, {
    readText: () => currentConfig,
    readJson: () => ({}),
    fileExists: () => true,
    skillCurrent: () => true,
    bootstrapCurrent: () => false
  });

  assert.equal(inspected.integrationStatus, 'update_available');
  assert.equal(inspected.integrationDetails.bootstrap, 'outdated');
});
