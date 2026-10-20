import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import {
  approvalBinds, approvalTerms, dataTransition, tamperedPackage, unavailablePermissions
} from './authorization.js';
import { ensureDataDirectory } from './data-directory.js';
import { appConflict } from './errors.js';
import { parseAgentAppManifest } from './manifest.js';
import { commitPackage, discardPackage, parsePackageFiles, stagePackage, storedPackageMatches } from './package-files.js';

// Submitting, approving and activating app versions. A version is immutable once
// stored, and only an explicit local approval of its exact digest lets it run.
export function createAppVersions(context) {
  const { store, now } = context;

  async function submit({ personalSpaceId, agentId, manifest: submittedManifest, files: submittedFiles }) {
    const manifest = parseAgentAppManifest(submittedManifest);
    const refusal = unavailablePermissions(manifest.permissions, context.grantable());
    if (refusal) throw refusal;
    const { files, bytes } = parsePackageFiles(submittedFiles, manifest);
    const owner = await ownerOf(context, { personalSpaceId, agentId });
    const appId = agentAppId(context.provider, owner, manifest.name);
    const { staging, digest } = stagePackage(context.packagesOf(appId), manifest, files);
    try {
      return store.transaction(() => {
        const existing = store.version(appId, manifest.version);
        if (existing) {
          if (existing.digest !== digest || existing.state === 'code_deleted') {
            throw appConflict('version_exists', `Version ${manifest.version} of this app already exists; submit a new version`);
          }
          return { ...submitted(appId, existing), idempotent: true };
        }
        const at = now();
        const app = store.app(appId);
        store.saveApp(app && app.status !== 'deleted' ? { ...app, updatedAt: at } : {
          appId, provider: context.provider, ...owner, name: manifest.name, status: 'pending',
          activeVersion: null, dataFormat: null, deletionTicket: null, deletionExpiresAt: null,
          createdAt: at, updatedAt: at, lastUsedAt: null
        });
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

  function approve({ appId, version, digest, approver, confirmResident = false, confirmIrreversibleMigration = false }) {
    return store.transaction(() => {
      const app = store.existingApp(appId);
      if (app.status === 'deleted') throw appConflict('app_deleted', 'This app and its data were deleted');
      const candidate = requiredVersion(appId, version);
      if (candidate.state !== 'pending') {
        throw appConflict('version_not_pending', `Version ${version} is ${candidate.state}; only a pending version is approved`);
      }
      if (digest !== candidate.digest) {
        throw appConflict('digest_mismatch', 'The package digest differs from the one approved; review the version again');
      }
      if (candidate.manifest.resident && !confirmResident) {
        throw appConflict('resident_confirmation_required',
          'This version runs a resident service, which needs its own confirmation');
      }
      const transition = activation(app, candidate, { confirmIrreversibleMigration });
      const at = now();
      store.insertApproval({ appId, version, ...approvalTerms(candidate),
        approvedBy: approver.user, channel: approver.channel, approvedAt: at });
      store.setVersionState(appId, version, 'approved');
      store.recordEvent({ appId, at, action: 'approved', version, actor: approver.user,
        detail: { digest, channel: approver.channel } });
      return activate(app, candidate, transition, { at, actor: approver.user, reason: 'superseded' });
    });
  }

  // Rollback and re-enabling both activate a version that was approved before.
  function rollback({ appId, version, actor, confirmIrreversibleMigration = false }) {
    return store.transaction(() => {
      const app = store.existingApp(appId);
      if (!['active', 'disabled'].includes(app.status)) {
        throw appConflict('app_not_activatable', `An app that is ${app.status} has no approved code to activate`);
      }
      const target = requiredVersion(appId, version);
      if (target.state !== 'approved') {
        throw appConflict('version_not_approved', `Version ${version} is ${target.state}; only an approved version is activated`);
      }
      if (!approvalBinds(store.approval(appId, version), target)) {
        throw appConflict('approval_mismatch', `The approval of version ${version} does not cover this package`);
      }
      const transition = activation(app, target, { confirmIrreversibleMigration });
      const at = now();
      store.recordEvent({ appId, at, action: app.activeVersion === version ? 'enabled' : 'rolled_back', version,
        actor: actor.user, detail: { from: app.activeVersion } });
      return activate(app, target, transition, { at, actor: actor.user, reason: 'rollback' });
    });
  }

  function disable({ appId, actor }) {
    return store.transaction(() => {
      const app = store.existingApp(appId);
      if (!['active', 'disabled'].includes(app.status)) {
        throw appConflict('app_not_active', `An app that is ${app.status} is not running`);
      }
      if (app.status === 'active') {
        const at = now();
        store.revokeTokens(appId, 'disabled', at);
        store.saveApp({ ...app, status: 'disabled', updatedAt: at });
        store.recordEvent({ appId, at, action: 'disabled', version: app.activeVersion, actor: actor.user });
      }
      return { appId, status: 'disabled', version: app.activeVersion };
    });
  }

  function requiredVersion(appId, version) {
    const record = store.version(appId, version);
    if (!record) throw new ApplicationError('version_not_found', 'This app has no such version', { status: 404 });
    return record;
  }

  function activation(app, version, options) {
    if (!storedPackageMatches(context.packageOf(app.appId, version.version), version.digest)) throw tamperedPackage();
    const refusal = unavailablePermissions(version.manifest.permissions, context.grantable());
    if (refusal) throw refusal;
    return dataTransition(app.dataFormat, version.manifest.data, options);
  }

  // The one place a version becomes the running one; earlier app tokens end here.
  function activate(app, version, transition, { at, actor, reason }) {
    store.revokeTokens(app.appId, reason, at);
    store.saveApp({ ...app, status: 'active', activeVersion: version.version, dataFormat: transition.dataFormat,
      deletionTicket: null, deletionExpiresAt: null, updatedAt: at });
    if (transition.migration) {
      const { note: _note, ...migration } = transition.migration;
      store.recordEvent({ appId: app.appId, at, action: 'data_migrated', version: version.version, actor, detail: migration });
    }
    if (version.manifest.data.scope === 'app') ensureDataDirectory(context.dataOf(app.appId));
    return { appId: app.appId, version: version.version, status: 'active', digest: version.digest,
      ...(transition.migration ? { dataMigration: transition.migration } : {}) };
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
function agentAppId(provider, { personalSpaceId, agentId }, name) {
  return `app-${contentHash({ provider, personalSpaceId, agentId, name }).slice(0, 32)}`;
}

function submitted(appId, version) {
  return {
    appId, version: version.version, status: version.state, digest: version.digest,
    ...(version.state === 'pending'
      ? { approval: `Runs only after the local user approves it: fuli app approve ${appId} ${version.version}` } : {})
  };
}
