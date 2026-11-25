import { existsSync } from 'node:fs';
import { JEFA_BOARD_FORMAT } from '../employees/builtin/jefa/board-store.js';
import { join } from 'node:path';
import { acquireFileLock } from '../storage/file-lock.js';
import { writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { openFormattedDatabase } from '../../packages/roundtable/src/storage/database-format.js';
import { ApplicationError } from '../app/application-error.js';
import { installationPhase, prepareInstallation, PROJECT_DESCRIPTOR_FORMAT } from './project-installation.js';
import { gateDirectory, initializeProjectGate, PROJECT_GATE_FORMAT } from './project-write-gate.js';
import { inventoryDigest } from './owner-inventory.js';
import { grantScope } from './scope-grants.js';

const refused = () => new ApplicationError('inventory_incomplete',
  'Project ownership is waiting for the local catalog. 正在等待本机项目盘点。', { status: 409 });

function catalogProof(catalog) {
  const ids = catalog?.projects;
  if (!Array.isArray(ids) || ids.length > 4096 || catalog.count !== ids.length || new Set(ids).size !== ids.length ||
    !ids.every(id => typeof id === 'string' && id.length <= 128 && grantScope('project:' + id) === 'project:' + id) ||
    inventoryDigest(ids) !== catalog.digest) throw refused();
  return ids;
}

// Only personal.ownProjectCatalog(..., { enrollment:true }) on this computer's
// authenticated Provider may supply the list. A peer hello carries no such list.
export async function enrollInstallation({ dataDir, descriptor, personal, registry, current }) {
  const { spaceId, device, authority } = descriptor;
  const release = acquireFileLock(join(dataDir, 'runner', 'project-enrollment.lock'));
  const matches = state => state?.spaceId === spaceId && state.device === device && state.authority === authority;
  const read = () => personal.ownProjectCatalog(spaceId, { enrollment: true });
  try {
    if (!current()) throw refused();
    prepareInstallation(dataDir);
    const previous = await read();
    if (!current() || !previous?.installation) throw refused();
    if (previous.installation.phase === 'active' && matches(previous.installation)) return;
    if (previous.installation.phase !== 'single' && !matches(previous.installation)) throw refused();
    if (installationPhase(dataDir, descriptor) !== 'preparing') throw refused();
    // A board writer may have started before this installation had control files.
    // Each writer now checks admission inside its own immediate transaction.
    const board = join(dataDir, 'employees', 'data', 'jefa', 'board.sqlite');
    if (existsSync(board)) {
      const db = openFormattedDatabase(board, JEFA_BOARD_FORMAT);
      try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK'); } finally { db.close(); }
    }
    const snapshot = await read();
    if (!current() || snapshot.installation?.phase !== 'preparing' || !matches(snapshot.installation)) throw refused();
    const ids = catalogProof(snapshot);
    const directory = gateDirectory(dataDir, spaceId);
    openFormattedDatabase(join(directory, 'index.sqlite'), PROJECT_GATE_FORMAT).close();
    if (device === authority && !registry.verified(device, ids).ok) throw refused();
    for (const project of ids) {
      const owner = device === authority ? registry.owner(project) : null;
      initializeProjectGate(directory, project, owner?.state === 'conflict' ? 'conflict' : 'owner', owner?.generation ?? 1);
    }
    if (!current()) throw refused();
    writeVersionedJsonFileAtomic(join(dataDir, 'runner', 'project-registry.json'),
      { version: 1, ...descriptor, projectMoves: 1 }, PROJECT_DESCRIPTOR_FORMAT, { durable: true });
    installationPhase(dataDir, descriptor, true);
    const active = await read();
    if (!current() || active.installation?.phase !== 'active' || !matches(active.installation)) throw refused();
  } finally { release(); }
}
