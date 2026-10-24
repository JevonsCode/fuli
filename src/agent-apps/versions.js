import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { createActivation } from './activation.js';
import { dataDeleting, rejectedManifest, unavailablePermissions } from './authorization.js';
import { decisionSource, UNVERIFIED_CHECK } from './decision-source.js';
import { appConflict } from './errors.js';
import { parseAgentAppManifest } from './manifest.js';
import { commitPackage, discardPackage, parsePackageFiles, stagePackage } from './package-files.js';

// Submitting app versions, and the local console's decisions on them. A version
// is immutable once stored, and only an approval of its exact digest makes it
// active. These decisions complete no terminal confirmation, so the run gate
// refuses the version they activate; `fuli app approve` and `rollback` do
// (confirmed-decisions.js).
// Each decision runs as an app operation (operations.js): an instance this
// process hosts is stopped first, and the owner lease is held throughout.
export function createAppVersions(context) {
  const { store, now, operations, leases } = context;
  const activation = createActivation(context);

  async function submit({ personalSpaceId, agentId, manifest: submittedManifest, files: submittedFiles }) {
    const rejectedNetwork = rejectedManifest(submittedManifest, null);
    if (rejectedNetwork) throw rejectedNetwork;
    const manifest = parseAgentAppManifest(submittedManifest);
    const rejected = rejectedManifest(submittedManifest, manifest);
    if (rejected) throw rejected;
    const refusal = unavailablePermissions(manifest.permissions, context.grantable());
    if (refusal) throw refusal;
    const { files, bytes } = parsePackageFiles(submittedFiles, manifest);
    const owner = await ownerOf(context, { personalSpaceId, agentId });
    const identityKey = agentAppIdentity(context.provider, owner, manifest.name);
    const appId = currentAppId(store.latestGeneration(identityKey), identityKey);
    const { staging, digest } = stagePackage(context.packagesOf(appId), manifest, files);
    try {
      return store.transaction(() => {
        const latest = store.latestGeneration(identityKey);
        if (currentAppId(latest, identityKey) !== appId) {
          throw appConflict('app_changed', 'This app changed while the version was submitted; submit it again');
        }
        if (latest?.status === 'data_deleting') throw dataDeleting();
        const existing = store.version(appId, manifest.version);
        if (existing) {
          if (existing.digest !== digest || existing.state === 'code_deleted') {
            throw appConflict('version_exists', `Version ${manifest.version} of this app already exists; submit a new version`);
          }
          return { ...submitted(appId, existing), idempotent: true };
        }
        const at = now();
        store.saveApp(latest?.appId === appId ? { ...latest, updatedAt: at } : {
          appId, provider: context.provider, ...owner, name: manifest.name, status: 'pending',
          activeVersion: null, dataFormat: null, deletionTicket: null, deletionExpiresAt: null,
          createdAt: at, updatedAt: at, lastUsedAt: null, identityKey, generation: (latest?.generation ?? 0) + 1
        });
        if (latest && latest.appId !== appId) {
          store.recordEvent({ appId: latest.appId, at, action: 'identity_regenerated', detail: { successor: appId } });
        }
        const version = { appId, version: manifest.version, state: 'pending', digest, manifest,
          files: files.length, bytes, submittedAt: at };
        store.insertVersion(version);
        store.recordEvent({ appId, at, action: 'submitted', version: manifest.version, actor: owner.agentId, detail: { digest } });
        commitPackage(staging, context.packageOf(appId, manifest.version));
        return submitted(appId, version);
      });
    } finally {
      discardPackage(staging);
    }
  }

  async function approve({ appId, version, digest, approver, confirmResident = false, confirmIrreversibleMigration = false }) {
    const source = decisionSource(approver);
    return operations.run(appId, 'approve', (lease) => store.transaction(() => {
      leases.assertOwned(lease);
      const prepared = activation.approvable({ appId, version, digest, confirmResident, confirmIrreversibleMigration });
      const result = activation.approve(prepared, { at: now(), actor: approver.user, detail: source, check: UNVERIFIED_CHECK });
      return { ...result, approval: source };
    }));
  }

  // Without a confirmation of its own, an activation never keeps the one an
  // earlier activation of the same version had.
  async function rollback({ appId, version, actor, confirmIrreversibleMigration = false }) {
    const source = decisionSource(actor);
    return operations.run(appId, 'rollback', (lease) => store.transaction(() => {
      leases.assertOwned(lease);
      const prepared = activation.reactivatable({ appId, version, confirmIrreversibleMigration });
      return activation.reactivate(prepared, { at: now(), actor: actor.user, detail: source, check: UNVERIFIED_CHECK });
    }));
  }

  async function disable({ appId, actor }) {
    const source = decisionSource(actor);
    return operations.run(appId, 'disable', (lease) => store.transaction(() => {
      leases.assertOwned(lease);
      const app = store.existingApp(appId);
      if (!['active', 'disabled'].includes(app.status)) {
        throw appConflict('app_not_active', `An app that is ${app.status} is not running`);
      }
      if (app.status === 'active') {
        const at = now();
        store.revokeTokens(appId, 'disabled', at);
        store.saveApp({ ...app, status: 'disabled', updatedAt: at });
        store.recordEvent({ appId, at, action: 'disabled', version: app.activeVersion, actor: actor.user,
          detail: source });
      }
      return { appId, status: 'disabled', version: app.activeVersion };
    }));
  }

  return { submit, approve, rollback, disable };
}

async function ownerOf(context, owner) {
  if (!context.resolveOwner) {
    throw new ApplicationError('app_submission_unavailable', 'Agents submit apps through a running FULI', { status: 503 });
  }
  try {
    const resolved = await context.resolveOwner(owner);
    return { personalSpaceId: resolved.personalSpaceId, agentId: resolved.agentId };
  } catch (error) {
    if (error?.status !== 404) throw error;
    throw new ApplicationError('owner_not_found', 'Only an existing FULI Agent in this personal space can own an app', { status: 404 });
  }
}

// Unique across Providers, spaces and Agents, so two Agents' apps of the same
// name never meet, and never derived from a display name alone.
function agentAppIdentity(provider, { personalSpaceId, agentId }, name) {
  return contentHash({ provider, personalSpaceId, agentId, name }).slice(0, 32);
}

// The app a submission adds to: the newest generation of its identity, or,
// once that one is deleted, the next generation under a new id (rec#7 D-28.9).
// The deleted one stays as its tombstone with its history; an id is never reused.
function currentAppId(latest, identityKey) {
  if (!latest) return `app-${identityKey}`;
  return latest.status === 'deleted' ? `app-${identityKey}-g${latest.generation + 1}` : latest.appId;
}

function submitted(appId, version) {
  return {
    appId, version: version.version, status: version.state, digest: version.digest,
    ...(version.state === 'pending'
      ? { approval: `Agent tools cannot approve it; it runs only after the local user completes the terminal confirmation: fuli app approve ${appId} ${version.version}` } : {})
  };
}
