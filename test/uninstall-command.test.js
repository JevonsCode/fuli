import assert from 'node:assert/strict';
import test from 'node:test';

import { runUninstallCommand } from '../src/cli/uninstall-command.js';
import { applyLocalUninstall, planLocalUninstall } from '../src/setup/uninstall.js';

const PLAN = Object.freeze({
  paths: {
    dataDir: 'C:/Fuli',
    backupDir: 'C:/Fuli/backups/agents',
    sessionSkillPath: 'C:/Package/skills/capturing-session-knowledge',
    projectSkillPath: 'C:/Package/skills/grilling-project',
    reviewSkillPath: 'C:/Package/skills/flreview'
  },
  agents: [{
    id: 'codex',
    label: 'Codex',
    available: true,
    configPath: 'C:/Codex/config.toml',
    skillPath: 'C:/Skills/capturing-session-knowledge',
    projectSkillPath: 'C:/Skills/grilling-project',
    reviewSkillPath: 'C:/Skills/flreview'
  }]
});

test('uninstall planning is side-effect free and finds installed integration artifacts', () => {
  const plan = planLocalUninstall({ dataDir: null }, {
    resolvePaths: () => PLAN.paths,
    discover: () => [
      PLAN.agents[0],
      {
        id: 'cursor',
        label: 'Cursor',
        available: false,
        configPath: 'C:/Cursor/mcp.json',
        skillPath: 'C:/Cursor/skills/session',
        projectSkillPath: 'C:/Cursor/skills/project',
        reviewSkillPath: 'C:/Cursor/skills/flreview'
      }
    ],
    fileExists: (path) => path === 'C:/Cursor/mcp.json'
  });

  assert.deepEqual(plan.agents.map(({ id }) => id), ['codex', 'cursor']);
});

test('uninstall disconnects integrations, removes only bundled Skills, and preserves data', async () => {
  const calls = [];
  const result = await applyLocalUninstall(PLAN, {
    stopRuntime: async () => ({ status: 'stopped' }),
    backupConfig: (agent) => {
      calls.push(`backup:${agent.id}`);
      return 'C:/Fuli/backups/agents/codex.toml';
    },
    disconnect: (agent) => {
      calls.push(`disconnect:${agent.id}`);
      return { status: 'disconnected' };
    },
    removeSkill: (agent) => {
      calls.push(`skill:${agent.skillPath.split('/').at(-1)}`);
      return { status: 'removed', path: agent.skillPath };
    }
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.data, { status: 'preserved', path: 'C:/Fuli' });
  assert.deepEqual(calls, [
    'backup:codex',
    'disconnect:codex',
    'skill:capturing-session-knowledge',
    'skill:grilling-project',
    'skill:flreview'
  ]);
});

test('uninstall stays partial when the local process cannot be safely confirmed stopped', async () => {
  const result = await applyLocalUninstall({ ...PLAN, agents: [] }, {
    stopRuntime: async () => ({
      status: 'partial',
      console: 'unverified',
      providers: 'stopped'
    })
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.data, { status: 'preserved', path: 'C:/Fuli' });
});

test('fl uninstall previews preserved data and --yes skips confirmation', async () => {
  const output = [];
  let confirmations = 0;
  const result = await runUninstallCommand(['--yes'], {
    planUninstall: () => PLAN,
    applyUninstall: async () => ({
      status: 'ready',
      runtime: { status: 'stopped' },
      agents: [],
      data: { status: 'preserved', path: 'C:/Fuli' }
    }),
    confirm: async () => { confirmations += 1; return false; },
    write: (line) => output.push(line)
  });

  assert.equal(confirmations, 0);
  assert.equal(result.status, 'ready');
  assert.match(output[0], /Data: preserve C:\/Fuli/);
  assert.match(output.at(-1), /npm uninstall --global fuli-context/);
  assert.doesNotMatch(output.join('\n'), /[\p{Script=Han}]/u);
});
