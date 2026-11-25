import { jsonFormat } from '../storage/json-format.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { holdFormattedSnapshot, immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { ApplicationError } from '../app/application-error.js';

export const PROJECT_DESCRIPTOR_FORMAT = jsonFormat({ store: 'project-registry', versions: [1] });
export const INSTALLATION_FILE = 'runner/project-installation.sqlite';
export const INSTALLATION_FORMAT = sqliteFormat({
  store: 'project-installation',
  schema: `CREATE TABLE IF NOT EXISTS installation(id INTEGER PRIMARY KEY CHECK(id=1),phase TEXT NOT NULL,
    space TEXT NOT NULL,device TEXT NOT NULL,authority TEXT NOT NULL);`
});
const unavailable = () => new ApplicationError('project_installation_unavailable',
  'This computer is checking project ownership. 正在核对这台电脑的项目归属。', { status: 409 });

function hasControlRecords(dataDir) {
  return ['project-registry.json', 'project-gates'].some(name => existsSync(join(dataDir, 'runner', name)));
}

export function prepareInstallation(dataDir) {
  const path = join(dataDir, INSTALLATION_FILE);
  if (!existsSync(path)) {
    if (hasControlRecords(dataDir)) throw unavailable();
    openFormattedDatabase(path, INSTALLATION_FORMAT).close();
  }
  return path;
}

export function installationRecord(dataDir) {
  const file = join(dataDir, INSTALLATION_FILE);
  if (!existsSync(file)) return null;
  const db = holdFormattedSnapshot(file, INSTALLATION_FORMAT);
  try { return db.prepare('SELECT * FROM installation WHERE id=1').get() ?? null; }
  finally { db.close(); }
}

// A write that started in single-computer mode retains its shared lock through
// its business commit. The first preparing commit waits for every such writer.
export function holdInstallation(dataDir) {
  const path = join(dataDir, INSTALLATION_FILE);
  if (!existsSync(path)) {
    if (hasControlRecords(dataDir)) throw unavailable();
    return null;
  }
  const db = holdFormattedSnapshot(path, INSTALLATION_FORMAT);
  try {
    const row = db.prepare('SELECT phase FROM installation WHERE id=1').get();
    if (row && row.phase !== 'active') throw unavailable();
    if (Boolean(row) !== existsSync(join(dataDir, 'runner', 'project-registry.json'))) throw unavailable();
    return () => db.close();
  } catch (error) { db.close(); throw error; }
}

export function installationPhase(dataDir, { spaceId, device, authority }, activate = false) {
  if (typeof spaceId !== 'string' || !spaceId || spaceId.length > 128 ||
    ![device, authority].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw unavailable();
  const db = openFormattedDatabase(prepareInstallation(dataDir), INSTALLATION_FORMAT);
  try {
    db.exec('PRAGMA busy_timeout=0');
    return immediateTransaction(db, () => {
      const row = db.prepare('SELECT * FROM installation WHERE id=1').get();
      if (!row && !activate) {
        db.prepare("INSERT INTO installation VALUES(1,'preparing',?,?,?)").run(spaceId, device, authority);
        return 'preparing';
      }
      if (row?.space !== spaceId || row.device !== device || row.authority !== authority ||
        !['active', 'preparing'].includes(row.phase)) throw unavailable();
      if (!activate || row.phase === 'active') return row.phase;
      db.prepare("UPDATE installation SET phase='active' WHERE id=1").run();
      return 'active';
    });
  } finally { db.close(); }
}
