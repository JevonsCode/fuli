import { ApplicationError } from '../app/application-error.js';
import {
  approvalBinds, approvalTerms, dataDeleting, dataTransition, tamperedPackage, unavailablePermissions
} from './authorization.js';
import { appConflict } from './errors.js';
import { storedPackageMatches } from './package-files.js';

// What approving or re-activating a version requires, and the one place a
// version becomes the running one. The console's unverified decisions
// (versions.js) and the CLI's presence-checked ones (verified-decisions.js)
// share it; each says which presence check the activation carries.
export function createActivation(context) {
  const { store } = context;

  function requiredVersion(appId, version) {
    const record = store.version(appId, version);
    if (!record) throw new ApplicationError('version_not_found', 'This app has no such version', { status: 404 });
    return record;
  }

  function approvable({ appId, version, digest, confirmResident = false, confirmIrreversibleMigration = false }) {
    const app = store.existingApp(appId);
    if (app.status === 'deleted') throw appConflict('app_deleted', 'This app and its data were deleted');
    if (app.status === 'data_deleting') throw dataDeleting();
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
    return { app, version: candidate, transition: transitionTo(app, candidate, { confirmIrreversibleMigration }) };
  }

  // Rollback and re-enabling both activate a version that was approved before.
  function reactivatable({ appId, version, confirmIrreversibleMigration = false }) {
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
    return { app, version: target, transition: transitionTo(app, target, { confirmIrreversibleMigration }) };
  }

  function transitionTo(app, version, options) {
    if (!storedPackageMatches(context.packageOf(app.appId, version.version), version.digest)) throw tamperedPackage();
    const refusal = unavailablePermissions(version.manifest.permissions, context.grantable());
    if (refusal) throw refusal;
    return dataTransition(app.dataFormat, version.manifest.data, options);
  }

  // detail: what the event records of the decision; check: its presence check.
  function approve({ app, version, transition }, { at, actor, detail, check }) {
    store.insertApproval({ appId: app.appId, version: version.version, ...approvalTerms(version), approvedBy: actor,
      entrypoint: detail.entrypoint, approvedAt: at }, check);
    store.setVersionState(app.appId, version.version, 'approved');
    store.recordEvent({ appId: app.appId, at, action: 'approved', version: version.version, actor,
      detail: { digest: version.digest, ...detail } });
    return activate(app, version, transition, { at, actor, reason: 'superseded' });
  }

  function reactivate({ app, version, transition }, { at, actor, detail, check }) {
    store.setApprovalCheck(app.appId, version.version, check);
    store.recordEvent({ appId: app.appId, at, action: app.activeVersion === version.version ? 'enabled' : 'rolled_back',
      version: version.version, actor, detail: { from: app.activeVersion, ...detail } });
    return activate(app, version, transition, { at, actor, reason: 'rollback' });
  }

  // Earlier app tokens end here. The data directory is not created here but when
  // an instance of the app first starts (instances.js, rec#7 D-28.17).
  function activate(app, version, transition, { at, actor, reason }) {
    store.revokeTokens(app.appId, reason, at);
    store.saveApp({ ...app, status: 'active', activeVersion: version.version, dataFormat: transition.dataFormat,
      deletionTicket: null, deletionExpiresAt: null, updatedAt: at });
    if (transition.migration) {
      const { note: _note, ...migration } = transition.migration;
      store.recordEvent({ appId: app.appId, at, action: 'data_migrated', version: version.version, actor, detail: migration });
    }
    return { appId: app.appId, version: version.version, status: 'active', digest: version.digest,
      ...(transition.migration ? { dataMigration: transition.migration } : {}) };
  }

  return { approvable, reactivatable, approve, reactivate };
}
