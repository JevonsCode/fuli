import { rmSync } from 'node:fs';
import { personOnlyRestore } from './guarded-stores.js';

import { ApplicationError } from '../app/application-error.js';
import { formatBackupNeeded } from '../data-format/backup-retention.js';
import { recordFormatOperations } from '../data-format/operations-log.js';
import { removeChildLogArchives } from '../local-runtime/child-process-log.js';

// The console's two old-data actions (rec#80 group B), on the local console only.
// - 恢复 puts a store's format backup back through the console's whole-store
//   restore (data-format/console-restore.js): it stops FULI, keeps the store as
//   it is now as a new format backup and starts FULI again, so the restore is
//   itself undone by restoring that backup. No other kind has a console restore.
// - 立即删除 removes the item for good: a log's kept copies the way 「清理旧日志」
//   removes them, anything else as files. A format backup an undo or the current
//   version still needs is refused, as pruning keeps it; one that goes is logged
//   like a pruned backup.
// shelf: the data directory's old-data port; restore: consoleRestore() or null.
export function createOldDataConsole({ shelf, restore = null, now = () => new Date(),
  remove = (path) => rmSync(path, { recursive: true, force: true }) }) {
  return {
    async restore(id, { delegated = false } = {}) {
      const item = await shelf.find(id);
      if (delegated && personOnlyRestore(item)) {
        throw new ApplicationError('old_data_restore_person_only', `${id} goes back only by the person's own click in Settings`, { status: 403 });
      }
      if (!item.restorable || !restore) {
        throw new ApplicationError('old_data_not_restorable', `${id} has no restore in the console`
          + (item.restoreCommand ? `; restore it at a terminal: ${item.restoreCommand}` : ''), { status: 409 });
      }
      const { currentDigest } = restore.describe(item.label, item.ref);
      const started = restore.start({ label: item.label, backupRef: item.ref, currentDigest });
      shelf.forgetMeasurement();
      return { id, restore: started };
    },
    async delete(id) {
      const item = await shelf.find(id);
      if (item.kind === 'format_backup' && formatBackupNeeded(shelf.dataDir, item.label, item.ref)) {
        throw new ApplicationError('old_data_needed', `${id} is still needed to undo a migration or to restore the `
          + 'store\'s current version; FULI keeps it', { status: 409 });
      }
      if (item.kind === 'log_archive') removeChildLogArchives(item.logPath);
      else item.targets.forEach(remove);
      if (item.kind === 'format_backup') {
        recordFormatOperations(shelf.dataDir, [{ kind: 'pruned', store: item.store, label: item.label,
          backupRef: item.ref, version: item.version, bytes: item.bytes, reason: 'deleted now by the person',
          at: now().toISOString() }]);
      }
      shelf.forgetMeasurement();
      return { id, freedBytes: item.bytes };
    }
  };
}
