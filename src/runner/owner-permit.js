import { gateDirectory, holdProjectWrites, initializeProjectGate } from './project-write-gate.js';

export function ownerPermitStore(dataDir, store) {
  function generation(record, scope) {
    const project = scope.slice('project:'.length);
    const row = store.db.prepare(`SELECT generation FROM project_permits WHERE
      authority=? AND space=? AND project=? AND owner=? AND state='owned'`)
      .get(record.authority, record.spaceId, project, record.device);
    if (!row) return null;
    try {
      holdProjectWrites(gateDirectory(dataDir, record.spaceId), [project], row.generation)();
      return row.generation;
    } catch { return null; }
  }
  function installPermit(record, permit) {
    // A refused or retired permit never opens a gate. If the process stops
    // after the permit commits, generation() keeps reads and writes closed
    // until installation retries and proves both records agree.
    const result = store.ownership().rememberPermit(record.authority, record.device, permit);
    if (!result.ok) return result;
    initializeProjectGate(gateDirectory(dataDir, record.spaceId), permit.project, 'owner', permit.generation);
    return result;
  }
  return { generation, installPermit };
}
