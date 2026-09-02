import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { backupAgentConfig } from '../src/setup/config-backup.js';

test('agent config backup copies an existing config before mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-setup-backup-'));
  const configPath = join(root, '.codex', 'config.toml');
  const backupDir = join(root, 'fuli', 'backups', 'agents');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, 'sensitive = "not-for-logs"\n', 'utf8');

  const backupPath = backupAgentConfig({ id: 'codex', configPath }, {
    backupDir,
    now: () => new Date('2026-07-15T01:02:03.004Z')
  });

  assert.equal(backupPath, join(backupDir, 'codex-2026-07-15T01-02-03-004Z.toml'));
  assert.equal(readFileSync(backupPath, 'utf8'), 'sensitive = "not-for-logs"\n');
  assert.equal(statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
});

test('agent config backup does nothing when the config is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-setup-backup-'));
  const backupDir = join(root, 'backups');

  assert.equal(backupAgentConfig({
    id: 'claude-code',
    configPath: join(root, '.claude.json')
  }, { backupDir }), null);
  assert.equal(existsSync(backupDir), false);
});

test('Claude Code backup preserves both MCP registration and lifecycle settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-setup-backup-'));
  const configPath = join(root, '.claude.json');
  const settingsPath = join(root, '.claude', 'settings.json');
  const backupDir = join(root, 'backups');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(configPath, '{"mcpServers":{}}\n', 'utf8');
  writeFileSync(settingsPath, '{"hooks":{}}\n', 'utf8');

  const backupPath = backupAgentConfig({
    id: 'claude-code',
    configPath,
    settingsPath
  }, {
    backupDir,
    now: () => new Date('2026-07-15T01:02:03.004Z')
  });

  assert.equal(
    backupPath,
    join(backupDir, 'claude-code-2026-07-15T01-02-03-004Z.json')
  );
  assert.equal(
    readFileSync(
      join(backupDir, 'claude-code-settings-2026-07-15T01-02-03-004Z.json'),
      'utf8'
    ),
    '{"hooks":{}}\n'
  );
});

test('standalone lifecycle hook files are included in Agent config backup', () => {
  const copies = [];
  backupAgentConfig({ id: 'cursor', configPath: '/synthetic/mcp.json',
    hooksPath: '/synthetic/hooks.json' }, {
    backupDir: '/synthetic/backups', fileExists: () => true,
    makeDirectory: () => {}, now: () => new Date('2026-08-30T00:00:00Z'),
    copyFile: (from, to) => copies.push([from, to]), setMode: () => {}
  });
  assert.equal(copies.length, 2);
  assert.deepEqual(copies[1], ['/synthetic/hooks.json', '/synthetic/backups/cursor-hooks-2026-08-30T00-00-00-000Z.json']);
});

test('Codex global instruction files are included in Agent config backup', () => {
  const copies = [];
  backupAgentConfig({
    id: 'codex',
    configPath: '/synthetic/config.toml',
    globalInstructionsPath: '/synthetic/AGENTS.md',
    globalInstructionsOverridePath: '/synthetic/AGENTS.override.md'
  }, {
    backupDir: '/synthetic/backups',
    fileExists: () => true,
    makeDirectory: () => {},
    now: () => new Date('2026-08-30T00:00:00Z'),
    copyFile: (from, to) => copies.push([from, to]),
    setMode: () => {}
  });

  assert.deepEqual(copies, [
    ['/synthetic/config.toml', '/synthetic/backups/codex-2026-08-30T00-00-00-000Z.toml'],
    ['/synthetic/AGENTS.md', '/synthetic/backups/codex-instructions-2026-08-30T00-00-00-000Z.md'],
    ['/synthetic/AGENTS.override.md', '/synthetic/backups/codex-instructions-override-2026-08-30T00-00-00-000Z.md']
  ]);
});
