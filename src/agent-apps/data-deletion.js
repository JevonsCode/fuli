import { existsSync } from 'node:fs';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import {
  dataDigest, deletingDirectories, deletingDirectoryOf, moveDataAside, removeDataDirectory
} from './data-directory.js';
import { appConflict } from './errors.js';

// The second deletion step, in four steps a crash can stop at any point
// (rec#7 D-28.14): ① commit status data_deleting; ② rename data/<appId> to
// data/<appId>.deleting-<id> in one atomic step; ③ remove that directory;
// ④ commit status deleted. settle() finishes or undoes what an earlier run
// left, at startup and before every operation on the app. Nothing here ever
// deletes a directory without a ticket the person confirmed: settle() only
// removes directories that ticket's rename produced. Every step runs inside
// the app's write gate under its owner lease and checks the fence first
// (D-28.17, D-28.21); a step after the file work whose fence no longer
// matches commits nothing (write_fenced_after_fs) and leaves the rest to the
// next owner's settle().
export function createDataDeletion(context) {
  const { store, leases, now } = context;

  async function deleteData({ app, ticket, lease, actor, source }) {
    const directory = context.dataOf(app.appId);
    const current = await dataDigest(directory);
    if (current.dataDigest !== app.deletionDataDigest) {
      store.transaction(() => {
        leases.assertOwned(lease);
        store.saveApp({ ...app, deletionTicket: null, deletionExpiresAt: null, deletionDataDigest: null, updatedAt: now() });
        store.recordEvent({ appId: app.appId, at: now(), action: 'data_changed_reconfirm',
          detail: { dataFiles: current.files, dataBytes: current.bytes } });
      });
      throw appConflict('data_changed_reconfirm',
        'The app data changed after the export offer; start the data deletion step again and confirm what is there now');
    }
    const deletionId = contentHash(ticket).slice(0, 16);
    const detail = { versions: store.versions(app.appId).length, dataBytes: current.bytes, dataFiles: current.files, ...source };
    store.transaction(() => {
      leases.assertOwned(lease);
      store.saveApp({ ...app, status: 'data_deleting', deletionTicket: null, deletionExpiresAt: null,
        deletionDataDigest: null, updatedAt: now() });
      store.recordEvent({ appId: app.appId, at: now(), action: 'data_deleting', actor, detail: { deletionId } });
    });
    const deleting = deletingDirectoryOf(directory, deletionId);
    leases.assertOwned(lease);
    moveDataAside(directory, deleting);
    leases.assertOwned(lease);
    try {
      removeDataDirectory(deleting);
    } catch (error) {
      store.transaction(() => {
        if (leases.owns(lease)) {
          store.recordEvent({ appId: app.appId, at: now(), action: 'data_deletion_failed', detail: { code: error?.code ?? null } });
        }
      });
      throw appConflict('data_deletion_incomplete',
        'The app data could not be removed completely; FULI finishes removing it before the next operation on this app');
    }
    return finish(app.appId, lease, { actor, detail, op: 'deleteData' });
  }

  function finish(appId, lease, { actor = null, detail, op }) {
    return store.transaction(() => {
      if (!leases.owns(lease)) {
        throw appConflict('write_fenced_after_fs', 'Another FULI process took over this app during its data deletion; '
          + 'it completes the deletion', { op });
      }
      const app = store.existingApp(appId);
      const at = now();
      store.eraseContent(appId);
      store.saveApp({ ...app, status: 'deleted', activeVersion: null, dataFormat: null, deletionTicket: null,
        deletionExpiresAt: null, deletionDataDigest: null, lastUsedAt: null, updatedAt: at });
      store.recordEvent({ appId, at, action: 'data_deleted', actor, detail });
      return { appId, status: 'deleted', deletedAt: at };
    });
  }

  // Inside the app's write gate, holding its lease.
  function settle(appId, lease) {
    const app = store.existingApp(appId);
    const directory = context.dataOf(appId);
    // Only the directory the confirmed deletion renamed is ever removed here;
    // any other .deleting-* directory is reported, never deleted.
    const deletionId = store.lastEvent(appId, 'data_deleting')?.detail?.deletionId;
    const confirmed = deletionId ? deletingDirectoryOf(directory, deletionId) : null;
    const leftovers = deletingDirectories(directory).filter((path) => path === confirmed);
    const strays = deletingDirectories(directory).filter((path) => path !== confirmed);
    if (strays.length) observeOnce(lease, appId, 'data_deletion_incomplete', { directories: strays.length });
    if (app.status === 'data_deleting') {
      if (existsSync(directory)) {
        // The rename never happened: the person confirms the deletion again.
        store.transaction(() => {
          leases.assertOwned(lease);
          store.saveApp({ ...app, status: 'code_deleted', updatedAt: now() });
          store.recordEvent({ appId, at: now(), action: 'data_deletion_interrupted' });
        });
        return null;
      }
      for (const path of leftovers) {
        leases.assertOwned(lease);
        removeDataDirectory(path);
      }
      return finish(appId, lease, { detail: { reconciled: true }, op: 'settle' });
    }
    if (app.status === 'deleted') {
      for (const path of leftovers) {
        leases.assertOwned(lease);
        removeDataDirectory(path);
      }
      // Only a manual restore puts a directory back; FULI keeps it and says so.
      if (existsSync(directory)) observeOnce(lease, appId, 'orphan_data_directory');
      return null;
    }
    if (leftovers.length) observeOnce(lease, appId, 'data_deletion_incomplete', { directories: leftovers.length });
    return null;
  }

  // A state found again before a later operation is recorded once.
  function observeOnce(lease, appId, action, detail = null) {
    store.transaction(() => {
      leases.assertOwned(lease);
      if (!store.lastEvent(appId, action)) store.recordEvent({ appId, at: now(), action, detail });
    });
  }

  return { deleteData, settle };
}
