import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { dataUsage, exportData as copyData, removeDataDirectory } from './data-directory.js';
import { appConflict } from './errors.js';
import { removePackages } from './package-files.js';

// The second step is confirmed within this window after its export offer.
const DATA_DELETION_WINDOW_MS = 10 * 60_000;

// Deleting an app takes two steps. The first removes code and pages, ends app
// tokens and keeps the data, so a later approved version continues with it.
// The second deletes the data after an export offer and a second confirmation,
// and leaves only the app identity and its content-free event history.
export function createAppRemoval(context) {
  const { store, now } = context;

  function deleteCode({ appId, actor }) {
    return store.transaction(() => {
      const app = store.existingApp(appId);
      if (app.status === 'deleted') throw appConflict('app_deleted', 'This app and its data were deleted');
      if (app.status !== 'code_deleted') {
        const at = now();
        store.revokeTokens(appId, 'code_deleted', at);
        const versions = store.markCodeDeleted(appId);
        store.saveApp({ ...app, status: 'code_deleted', activeVersion: null, updatedAt: at });
        store.recordEvent({ appId, at, action: 'code_deleted', actor: actor.user, detail: { versions } });
      }
      removePackages(context.packagesOf(appId));
      return {
        appId, status: 'code_deleted', dataKept: true, dataBytes: dataUsage(context.dataOf(appId)).bytes,
        recover: 'The data is kept. When the owning Agent submits a new version and you approve it, the app continues with this data.',
        deleteData: `fuli app delete ${appId} --data`
      };
    });
  }

  function prepareDataDeletion({ appId }) {
    return store.transaction(() => {
      const app = codeDeletedApp(appId);
      const ticket = randomBytes(18).toString('base64url');
      const expiresAt = new Date(context.clock().getTime() + DATA_DELETION_WINDOW_MS).toISOString();
      const usage = dataUsage(context.dataOf(appId));
      const at = now();
      store.saveApp({ ...app, deletionTicket: contentHash(ticket), deletionExpiresAt: expiresAt, updatedAt: at });
      store.recordEvent({ appId, at, action: 'data_deletion_offered', detail: { dataBytes: usage.bytes } });
      return {
        appId, dataBytes: usage.bytes, dataFiles: usage.files,
        export: `fuli app export ${appId} --output <new-directory>`,
        warning: 'Deleting the data cannot be undone. Export it first if it may be needed.',
        confirm: appId, ticket, expiresAt
      };
    });
  }

  function deleteData({ appId, ticket, confirm, actor }) {
    return store.transaction(() => {
      const app = codeDeletedApp(appId);
      if (confirm !== appId) {
        throw appConflict('deletion_confirmation_required', `Confirm with the app id ${appId} to delete its data`);
      }
      if (!app.deletionTicket || typeof ticket !== 'string' || contentHash(ticket) !== app.deletionTicket) {
        throw appConflict('deletion_ticket_invalid', 'Start the data deletion step again; it offers an export first');
      }
      if (Date.parse(app.deletionExpiresAt) <= context.clock().getTime()) {
        throw appConflict('deletion_ticket_expired', 'The data deletion step expired; start it again');
      }
      const usage = dataUsage(context.dataOf(appId));
      const versions = store.versions(appId).length;
      const at = now();
      store.eraseContent(appId);
      store.saveApp({ ...app, status: 'deleted', activeVersion: null, dataFormat: null,
        deletionTicket: null, deletionExpiresAt: null, lastUsedAt: null, updatedAt: at });
      store.recordEvent({ appId, at, action: 'data_deleted', actor: actor.user,
        detail: { versions, dataBytes: usage.bytes, dataFiles: usage.files } });
      removeDataDirectory(context.dataOf(appId));
      return { appId, status: 'deleted', deletedAt: at };
    });
  }

  function exportData({ appId, destination }) {
    const app = store.existingApp(appId);
    if (app.status === 'deleted') throw appConflict('app_deleted', 'This app and its data were deleted');
    const usage = copyData(context.dataOf(appId), destination);
    store.recordEvent({ appId, at: now(), action: 'data_exported', detail: usage });
    return { appId, destination, ...usage };
  }

  function codeDeletedApp(appId) {
    const app = store.existingApp(appId);
    if (app.status !== 'code_deleted') {
      throw appConflict('code_deletion_required', 'Delete the app code first; deleting its data is the second step');
    }
    return app;
  }

  return { deleteCode, prepareDataDeletion, deleteData, exportData };
}
