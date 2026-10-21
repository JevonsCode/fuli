import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// How a store's format backups are named and found (rec#17 D-09): beside the
// store in format-backups/, as <store file>.v<version it was taken from>-<UTC
// time>.<extension>. One rule for SQLite and JSON stores, read back by
// rollback, restore and backup retention.

export const BACKUP_DIRECTORY = 'format-backups';
const NAME = /^(.+)\.v(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(sqlite|json)$/;

export function formatBackupName(storePath, version, at, extension) {
  return `${basename(storePath)}.v${version}-${at.toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

// ref is what ledgers record: format-backups/<name>.
export function parseFormatBackupRef(ref) {
  const match = typeof ref === 'string' && ref.startsWith(`${BACKUP_DIRECTORY}/`)
    ? NAME.exec(ref.slice(BACKUP_DIRECTORY.length + 1)) : null;
  if (!match) return null;
  const [name, storeFile, version, stamp] = match;
  return { name, storeFile, version: Number(version),
    takenAt: stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z') };
}

// The backups of one store file, oldest first.
export function formatBackupsOf(storePath) {
  const directory = join(dirname(storePath), BACKUP_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map((name) => ({ ref: `${BACKUP_DIRECTORY}/${name}`,
    ...parseFormatBackupRef(`${BACKUP_DIRECTORY}/${name}`) }))
    .filter((entry) => entry.storeFile === basename(storePath))
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}

// The file of a backup of exactly this store, or null: never a path outside
// its backup directory or another store's backup.
export function formatBackupPath(storePath, ref) {
  const entry = formatBackupsOf(storePath).find((candidate) => candidate.ref === ref);
  return entry ? join(dirname(storePath), BACKUP_DIRECTORY, entry.name) : null;
}
