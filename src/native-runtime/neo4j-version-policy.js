// Which Neo4j version changes FULI makes without a separate data migration: an
// upward patch within one major.minor (5.26.0 → 5.26.28). Neo4j may raise a
// store's kernel version when it first opens it, so a change never goes down a
// patch: the older Neo4j might not open what the newer one left.

import { join } from 'node:path';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

// Where the graph backup before switching to Neo4j `version` goes. `fuli graph
// export` creates it with the installed Neo4j, before the newer one opens the store.
export function neo4jUpgradeBackupPath(graphBackupDir, version, now = new Date()) {
  return join(graphBackupDir, `before-neo4j-${version}-${now.toISOString().replace(/[:.]/g, '-')}`);
}

// True when bundled is a newer patch of installed, false when they are equal.
// backup: where the graph backup from before the last upgrade is kept, named
// when a downgrade is refused.
export function neo4jPatchUpgrade(installed, bundled, { backup = null } = {}) {
  if (installed === bundled) return false;
  const [from, to] = [installed, bundled].map(version => VERSION.exec(version ?? '')?.slice(1).map(Number));
  if (!from || !to || from[0] !== to[0] || from[1] !== to[1]) {
    throw new Error(`Neo4j version ${installed} → ${bundled} changes the major or minor version; that needs a separate data migration. Nothing was changed.`);
  }
  if (to[2] > from[2]) return true;
  throw new Error(`Neo4j version ${installed} → ${bundled} is a downgrade: ${installed} may have upgraded the graph store, and ${bundled} might not open it. Nothing was changed.`
    + (backup ? ` The graph backup taken before the upgrade is kept at ${backup}; restoring it discards graph changes made since then.` : ''));
}
