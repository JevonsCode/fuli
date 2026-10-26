import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { createDataDeletion } from './data-deletion.js';
import { dataDigest, dataUsage, exportData as copyData } from './data-directory.js';
import { decisionSource } from './decision-source.js';
import { appConflict } from './errors.js';
import { removePackages } from './package-files.js';

// The second step is confirmed within this window after its export offer.
const DATA_DELETION_WINDOW_MS = 10 * 60_000;

// Deleting an app takes two steps. The first removes code and pages, ends app
// tokens and keeps the data, so a later approved version continues with it.
// The second deletes the data after an export offer and a second confirmation,
// and leaves only the app identity and its content-free event history. Each
// step, and an export, runs as an app operation (operations.js) under the
// app's owner lease and write gate; the offer binds the content digest of the
// data (rec#7 D-28.14), so data that changed after the offer is never deleted
// on that confirmation.
export function createAppRemoval(context) {
  const { store, now, operations, leases, instances } = context;
  const deletion = createDataDeletion(context);

  async function deleteCode({ appId, actor }) {
    const source = decisionSource(actor);
    return operations.run(appId, 'deleteCode', (lease) => store.transaction(() => {
      leases.assertOwned(lease);
      const app = store.existingApp(appId);
      if (['deleted', 'data_deleting'].includes(app.status)) throw appConflict('app_deleted', 'This app and its data were deleted');
      if (app.status !== 'code_deleted') {
        const at = now();
        store.revokeTokens(appId, 'code_deleted', at);
        const versions = store.markCodeDeleted(appId);
        store.saveApp({ ...app, status: 'code_deleted', activeVersion: null, updatedAt: at });
        store.recordEvent({ appId, at, action: 'code_deleted', actor: actor.user, detail: { versions, ...source } });
      }
      removePackages(context.packagesOf(appId));
      return {
        appId, status: 'code_deleted', dataKept: true, dataBytes: dataUsage(context.dataOf(appId)).bytes,
        recover: 'The data is kept. When the owning Agent submits a new version and you approve it, the app continues with this data.',
        deleteData: `fuli app delete ${appId} --data`
      };
    }));
  }

  async function prepareDataDeletion({ appId }) {
    return operations.run(appId, 'prepareDataDeletion', async (lease) => {
      codeDeletedApp(appId);
      const offered = await dataDigest(context.dataOf(appId));
      return store.transaction(() => {
        leases.assertOwned(lease);
        const app = codeDeletedApp(appId);
        const ticket = randomBytes(18).toString('base64url');
        const expiresAt = new Date(context.clock().getTime() + DATA_DELETION_WINDOW_MS).toISOString();
        const at = now();
        store.saveApp({ ...app, deletionTicket: contentHash(ticket), deletionExpiresAt: expiresAt,
          deletionDataDigest: offered.dataDigest, updatedAt: at });
        store.recordEvent({ appId, at, action: 'data_deletion_offered', detail: { dataBytes: offered.bytes, dataFiles: offered.files } });
        return {
          appId, dataBytes: offered.bytes, dataFiles: offered.files,
          export: `fuli app export ${appId} --output <new-directory>`,
          warning: 'Deleting the data cannot be undone. Export it first if it may be needed.',
          confirm: appId, ticket, expiresAt
        };
      });
    });
  }

  async function deleteData({ appId, ticket, confirm, actor }) {
    const source = decisionSource(actor);
    return operations.run(appId, 'deleteData', (lease) => {
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
      return deletion.deleteData({ app, ticket, lease, actor: actor.user, source });
    });
  }

  // Only with no instance: there is no snapshot of a running app.
  async function exportData({ appId, destination }) {
    return operations.run(appId, 'exportData', (lease) => {
      instances.assertNoInstance(appId);
      const app = store.existingApp(appId);
      if (['deleted', 'data_deleting'].includes(app.status)) throw appConflict('app_deleted', 'This app and its data were deleted');
      leases.assertOwned(lease);
      const usage = copyData(context.dataOf(appId), destination);
      store.transaction(() => {
        leases.assertOwned(lease);
        store.recordEvent({ appId, at: now(), action: 'data_exported', detail: usage });
      });
      return { appId, destination, ...usage };
    }, { keepInstance: true });
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
