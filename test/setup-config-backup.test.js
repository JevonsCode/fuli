import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
