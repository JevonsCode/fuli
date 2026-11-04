import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

import { BACKUP_DIRECTORY, formatBackupsOf } from '../../packages/roundtable/src/storage/format-backup-names.js';
import { localStoreFiles } from '../data-format/local-stores.js';
import { readFormatOperations } from '../data-format/operations-log.js';
import { childLogArchives } from '../local-runtime/child-process-log.js';
import { allocatedPathSize } from '../system/resource-monitor.js';
import { fuliLogPaths } from '../system/log-paths.js';

// 旧数据 (rec#80 group B): the copies FULI already keeps under the data
// directory before it changes something, listed in one place so the person
// (or their own AI) sees what each is, which action left it, when and how big,
// and whether FULI can put it back. Nothing here writes. Each item names the
// restore that already exists for it: only a store's format backup has one in
// the console (data-format/console-restore.js); a graph export is imported
// again at a terminal (fuli graph import); the others have none.
//
// What is not listed: graph undo journals live inside the graph and are
// pruned by the format retention budget (format-retention.js); permanent
// deletes keep no content (knowledge-hard-delete/delete-ledger.js).

// Kinds: format_backup, graph_export, settings_backup, client_config_backup, log_archive.
const GRAPH_IMPORT = 'fuli graph import --input <folder>';

// Every old-data item of one data directory, newest first. paths: resolveSetupPaths().
export async function oldDataInventory(paths) {
  const found = [
    ...formatBackups(paths.dataDir),
    ...graphExports(paths.graphBackupDir),
    ...childEntries(paths.runtimeSettingsBackupDir, 'settings_backup', settingsLeft),
    ...childEntries(paths.backupDir, 'client_config_backup', clientConfigLeft),
    ...logArchives(paths)
  ];
  const items = await Promise.all(found.map(async (item) => ({
    ...item,
    id: `${item.kind}:${relativeTo(paths.dataDir, item.anchor)}`,
    path: relativeTo(paths.dataDir, item.anchor),
    bytes: (await Promise.all(item.targets.map(allocatedPathSize))).reduce((sum, bytes) => sum + bytes, 0)
  })));
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

// What a caller outside this module sees of an item: never an absolute path.
export function publicOldDataItem({ id, kind, path, left, createdAt, bytes, restorable, restoreCommand }) {
  return { id, kind, path, left, createdAt, bytes, restorable, restoreCommand };
}

function formatBackups(dataDir) {
  const operations = readFormatOperations(dataDir);
  return localStoreFiles(dataDir).flatMap((store) => formatBackupsOf(store.path).map((backup) => {
    const file = join(dirname(store.path), BACKUP_DIRECTORY, backup.name);
    return { kind: 'format_backup', anchor: file, targets: [file], label: store.label, store: store.format.store, ref: backup.ref,
      version: backup.version, createdAt: backup.takenAt, left: formatBackupLeft(store.label, backup, operations),
      restorable: true, restoreCommand: null };
  }));
}

// The operations log names the step a backup was taken for; an older backup
// the log no longer holds says only what it is.
function formatBackupLeft(label, backup, operations) {
  const same = (event) => event.label === label;
  if (operations.some((event) => same(event) && event.kind === 'restored' && event.safetyBackupRef === backup.ref)) {
    return { zh: `整体恢复前保留的 ${label}`, en: `${label} as it was before a whole-store restore` };
  }
  const applied = operations.find((event) => same(event) && event.kind === 'applied' && event.backupRef === backup.ref);
  if (applied) {
    return { zh: `升级数据格式前的 ${label}（v${applied.fromVersion}→v${applied.toVersion}）`,
      en: `${label} before its data format went from v${applied.fromVersion} to v${applied.toVersion}` };
  }
  return { zh: `数据格式变更前的 ${label}（v${backup.version}）`,
    en: `${label} before a data format change (v${backup.version})` };
}

function graphExports(root) {
  return directoryEntries(root).filter(({ name, stats }) => stats.isDirectory() && !name.includes('.partial-'))
    .map(({ path, name, stats }) => {
      const manifest = readManifest(path);
      return { kind: 'graph_export', anchor: path, targets: [path], left: graphExportLeft(name),
        createdAt: validTime(manifest?.createdAt) ?? stats.mtime.toISOString(), restorable: false,
        restoreCommand: manifest ? GRAPH_IMPORT : null };
    });
}

function graphExportLeft(name) {
  const neo4j = /^before-neo4j-(.+?)-\d{4}-\d{2}-\d{2}T/.exec(name);
  if (neo4j) return { zh: `升级 Neo4j ${neo4j[1]} 前的图谱`, en: `The graph before the Neo4j ${neo4j[1]} upgrade` };
  if (name.startsWith('container-to-native-')) {
    return { zh: '从 Docker 迁到内置图谱时导出的图谱', en: 'The graph exported when it moved from Docker to the built-in graph' };
  }
  if (name.startsWith('before-import-')) return { zh: '导入图谱前保留的图谱', en: 'The graph kept before a graph import' };
  return { zh: '图谱导出', en: 'A graph export' };
}

function settingsLeft() {
  return { zh: '更换控制台端口前的运行设置', en: 'Runtime settings before the console port was changed' };
}

// One item per client: what agent-installer and the legacy hook cleanup copied
// before they changed that client's configuration.
function clientConfigLeft(name) {
  return { zh: `接入前保存的 ${name} 原配置`, en: `${name}'s configuration as it was before FULI connected it` };
}

function childEntries(root, kind, left) {
  return directoryEntries(root).map(({ path, name, stats }) => ({ kind, anchor: path, targets: [path],
    left: left(name), createdAt: stats.mtime.toISOString(), restorable: false, restoreCommand: null }));
}

// One item per log: the copies rotation kept (`.1` to `.3`), never the log itself.
function logArchives(paths) {
  return fuliLogPaths(paths).flatMap((logPath) => {
    const copies = childLogArchives(logPath);
    if (!copies.length) return [];
    const newest = Math.max(...copies.map(({ path }) => statSync(path).mtimeMs));
    return [{ kind: 'log_archive', anchor: logPath, logPath, targets: copies.map(({ path }) => path),
      left: { zh: `日志超过 50 MB 后留下的旧 ${basename(logPath)}`, en: `Older ${basename(logPath)} kept after it passed 50 MB` },
      createdAt: new Date(newest).toISOString(), restorable: false, restoreCommand: null }];
  });
}

function directoryEntries(root) {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(root, entry.name), stats: statSync(join(root, entry.name)) }));
}

function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function relativeTo(dataDir, path) {
  return relative(dataDir, path).split(sep).join('/');
}
