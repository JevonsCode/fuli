import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUninstallResult, runUninstallCommand } from '../src/cli/uninstall-command.js';
import { applyLocalUninstall, planLocalUninstall, removalTarget } from '../src/setup/uninstall.js';

const PLAN = Object.freeze({
  paths: {
    dataDir: 'C:/Fuli',
    backupDir: 'C:/Fuli/backups/agents',
    sessionSkillPath: 'C:/Package/skills/capturing-session-knowledge',
    projectSkillPath: 'C:/Package/skills/grilling-project',
    reviewSkillPath: 'C:/Package/skills/flreview',
    operationSkillPath: 'C:/Package/skills/operating-fuli'
  },
  agents: [{
    id: 'codex',
    label: 'Codex',
    available: true,
    configPath: 'C:/Codex/config.toml',
    skillPath: 'C:/Skills/capturing-session-knowledge',
    projectSkillPath: 'C:/Skills/grilling-project',
    reviewSkillPath: 'C:/Skills/flreview',
    operationSkillPath: 'C:/Skills/operating-fuli'
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
        reviewSkillPath: 'C:/Cursor/skills/flreview',
        operationSkillPath: 'C:/Cursor/skills/operating-fuli'
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
    'skill:flreview',
    'skill:operating-fuli'
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

test('portable uninstall says to delete the folder and warns when data lives inside it', async () => {
  const portable = { ...PLAN, paths: { ...PLAN.paths, portableRoot: 'C:/Portable Fuli', dataDir: 'C:/Portable Fuli/data' } };
  const removal = removalTarget(portable.paths);
  assert.deepEqual(removal, { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: true });
  const output = [];
  await runUninstallCommand(['--yes'], {
    planUninstall: () => portable,
    applyUninstall: async () => ({ status: 'ready', runtime: { status: 'stopped' }, agents: [],
      data: { status: 'preserved', path: portable.paths.dataDir }, removal }),
    write: line => output.push(line)
  });
  const text = output.join('\n');
  assert.doesNotMatch(text, /npm uninstall|Neo4j volumes/);
  assert.match(output.at(-1), /delete this portable folder: C:\/Portable Fuli[\s\S]*move it out of C:\/Portable Fuli first/);
  assert.match(output[0], /data directory is inside the portable folder/);
});

test('portable data outside the folder needs no warning; npm installs keep the npm instruction', () => {
  assert.deepEqual(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir: 'D:/Fuli data' }),
    { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false });
  assert.deepEqual(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir: 'C:/Portable Fuli other/data' }),
    { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false });
  assert.deepEqual(removalTarget({ portableRoot: null, dataDir: 'C:/Fuli' }), { kind: 'npm_global' });
  assert.match(formatUninstallResult({ status: 'ready', runtime: { status: 'stopped' }, agents: [],
    data: { path: 'D:/Fuli data' }, removal: { kind: 'portable_folder', path: 'C:/Portable Fuli', dataInside: false } }),
    /delete this portable folder: C:\/Portable Fuli$/);
});

test('a data folder whose name starts with two dots is still inside the portable folder', () => {
  for (const dataDir of ['C:/Portable Fuli/..data', 'C:\\Portable Fuli\\..data\\graph', 'C:/Portable Fuli']) {
    assert.equal(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir }).dataInside, true, dataDir);
  }
  for (const dataDir of ['C:/data', 'C:\\Portable Fuli other\\data', 'D:/Portable Fuli/data']) {
    assert.equal(removalTarget({ portableRoot: 'C:/Portable Fuli', dataDir }).dataInside, false, dataDir);
  }
});
