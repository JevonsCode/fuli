import { join } from 'node:path';

import { readVerifiedGraphBackup } from '../backup/graph-backup.js';
import { createGraphBackupAdapter, managedGraphInstances } from '../backup/runtime-adapters.js';
import { createNativeGraphServices } from './runtime.js';

// What a recovery (neo4j-recovery.js) does through the native runtime itself,
// each under the lock's own token [owner], which re-enters the operations the
// lock holds back: stopping the recorded services, starting a Neo4j to check
// it answers, and loading a database. The CLI and the desktop controller both
// recover through this.
export function nativeRecoveryServices({ paths, env = process.env }) {
  const services = (owner, options = {}) => createNativeGraphServices({ paths, ...options,
    env: { ...env, FULI_NATIVE_ASSET_OPERATION: owner } });
  return {
    stopServices: owner => services(owner).stopDatabases(),
    // The checks a switch makes after it wrote the descriptor (neo4j-lifecycle.js):
    // the databases start with [descriptor], answer the health check, and stop again.
    checkStart: async (descriptor, owner) => {
      const selected = services(owner, { runtimeDescriptor: descriptor });
      try {
        await selected.start({ providers: false });
        for (const instance of managedGraphInstances(paths)) await selected.checkDatabaseHealth(instance);
      } finally {
        await selected.stopDatabases();
      }
    },
    // The whole graph back from an import's own copy, the way the import's
    // rollback loads it (graph-backup.js): checksums first, no new copy of the
    // half-written store.
    // A copy that fails its checks is marked [copyDamaged]: it will never restore.
    restore: async ({ from, instances }, owner) => {
      let manifest;
      try { manifest = await readVerifiedGraphBackup(from); }
      catch (error) { throw Object.assign(new Error(`The copy ${from} failed its checks.`, { cause: error }), { copyDamaged: true }); }
      if (manifest.instances.map(({ id }) => id).sort().join() !== [...instances].sort().join()) {
        throw Object.assign(new Error('The copy holds other graph instances than the plan said.'), { copyDamaged: true });
      }
      const adapter = await createGraphBackupAdapter({ mode: 'native', paths,
        createNativeServices: options => services(owner, options) });
      await adapter.stop();
      // Which instance a failed restore was writing, and which it brought back
      // before: abandoning the import afterwards says which graph is which (load-recovery.js).
      const restored = [];
      for (const entry of manifest.instances) {
        try { await adapter.load(entry.id, join(from, entry.file)); }
        catch (error) { throw Object.assign(error, { instance: entry.id, restored }); }
        restored.push(entry.id);
      }
    }
  };
}
