import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { nowIso } from '../models.js';
import { isFileDatabase } from './sqlite/open-database.js';

const DEFAULT_MIGRATIONS_DIRECTORY = new URL('./migrations/', import.meta.url);
const CHECKSUM_UPGRADE_MIGRATION = '002-storage-integrity.sql';

export function configureDatabase(db, filePath) {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (isFileDatabase(filePath)) db.pragma('journal_mode = WAL');
}

export function runMigrations(
  db,
  { migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY } = {}
) {
  db.pragma('foreign_keys = ON');
  const migrations = discoverMigrations(migrationsDirectory);
  for (const migration of migrations) {
    const migrate = db.transaction(() => {
      const state = appliedMigrations(db);
      verifyAppliedMigrations(migrations, state.records, {
        allowMissingChecksums: hasPendingChecksumUpgrade(migrations, state)
      });
      if (state.records.has(migration.version)) return;
      db.exec(migration.sql);
      recordMigration(db, migration);
    });
    migrate.immediate();
  }
  verifyAppliedMigrations(migrations, appliedMigrations(db).records);
}

function discoverMigrations(directory) {
  const migrations = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)-.+\.sql$/.exec(name);
      if (!match) throw new Error(`Invalid migration filename: ${name}`);
      const sql = readFileSync(migrationPath(directory, name), 'utf8');
      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex')
      };
    })
    .sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(`Duplicate migration version: ${migrations[index].version}`);
    }
  }
  return migrations;
}

function appliedMigrations(db) {
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all();
  if (columns.length === 0) return { records: new Map(), supportsChecksums: false };

  const supportsChecksums = columns.some((column) => column.name === 'checksum');
  const rows = supportsChecksums
    ? db.prepare(`
        SELECT version, checksum FROM schema_migrations ORDER BY version
      `).all()
    : db.prepare(`
        SELECT version, NULL AS checksum FROM schema_migrations ORDER BY version
      `).all();
  return {
    records: new Map(rows.map((row) => [row.version, row.checksum])),
    supportsChecksums
  };
}

function verifyAppliedMigrations(
  migrations,
  applied,
  { allowMissingChecksums = false } = {}
) {
  const available = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const [version, checksum] of applied) {
    const migration = available.get(version);
    if (!migration) {
      throw new Error(
        `Applied migration version ${version} is missing from the migration directory`
      );
    }
    if (checksum === null && allowMissingChecksums) continue;
    if (checksum === null) {
      throw new Error(`Applied migration version ${version} is missing a checksum`);
    }
    if (migration.checksum !== checksum) {
      throw new Error(`Migration checksum mismatch for version ${version}`);
    }
  }
}

function hasPendingChecksumUpgrade(migrations, state) {
  if (state.supportsChecksums) return false;
  const migration = migrations.find(
    (candidate) => candidate.name === CHECKSUM_UPGRADE_MIGRATION
  );
  return migration !== undefined && !state.records.has(migration.version);
}

function recordMigration(db, migration) {
  const supportsChecksums = db.prepare('PRAGMA table_info(schema_migrations)').all()
    .some((column) => column.name === 'checksum');
  if (supportsChecksums) {
    db.prepare(`
      INSERT INTO schema_migrations (version, checksum, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.checksum, nowIso());
    return;
  }
  db.prepare(`
    INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)
  `).run(migration.version, nowIso());
}

function migrationPath(directory, name) {
  return directory instanceof URL ? new URL(name, directory) : join(directory, name);
}
