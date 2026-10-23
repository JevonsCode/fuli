import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { appConflict } from './errors.js';
import { hostToolEntry } from './host-tools/catalog.js';

// What an approval covers: the exact package and everything the user saw.
export function approvalTerms(version) {
  const { permissions, data, resident } = version.manifest;
  return { digest: version.digest, permissions, data, resident };
}

export function approvalBinds(approval, version) {
  if (!approval) return false;
  const { digest, permissions, data, resident } = approval;
  return canonicalJson({ digest, permissions, data, resident }) === canonicalJson(approvalTerms(version));
}

export function tamperedPackage() {
  return appConflict('package_tampered', 'The stored package no longer matches its digest, so it will not run');
}

export function dataDeleting() {
  return appConflict('app_data_deleting', 'This app\'s data is being deleted; nothing new is added to it');
}

// What no app may ask for, refused at submission and never silently dropped
// (rec#7 D-28.3, D-28.4): network access, and any tool marked egress, model
// or launch in the host tool catalog.
export function rejectedManifest(submitted, manifest) {
  const reasons = [];
  if (submitted !== null && typeof submitted === 'object' && Object.hasOwn(submitted, 'network')) {
    reasons.push('network: apps have no network; their only channel is the FULI host');
  }
  if (manifest) {
    for (const permission of manifest.permissions) {
      const marks = hostToolEntry(permission.slice('fuli.'.length))?.marks ?? [];
      if (marks.length) reasons.push(`${permission} is marked ${marks.join(', ')}`);
    }
  }
  return reasons.length ? new ApplicationError('manifest_rejected',
    `Apps may not send data off this computer, spend model budget or start other programs: ${reasons.join('; ')}`,
    { status: 400 }) : null;
}

// The FULI Agent tools of today an app may be granted.
export function grantableTools(toolNames) {
  return new Set(toolNames.filter((name) => hostToolEntry(name)?.grantable).map((name) => `fuli.${name}`));
}

// Authorization is checked against today's grantable tools, not the day of approval.
export function unavailablePermissions(permissions, grantable) {
  const missing = permissions.filter((permission) => !grantable.has(permission));
  return missing.length ? appConflict('permission_unavailable',
    `These permissions are not grantable to an app: ${missing.join(', ')}`) : null;
}

// Activating a version hands it the app data directory. The data stays in its
// current format unless this version declares it can open and convert it.
export function dataTransition(currentFormat, data, { confirmIrreversibleMigration }) {
  if (data.scope === 'none') return { dataFormat: currentFormat, migration: null };
  if (currentFormat === null || currentFormat === data.format) return { dataFormat: data.format, migration: null };
  if (!data.accepts.includes(currentFormat)) {
    throw appConflict('data_format_incompatible',
      `The app data is in format ${currentFormat}; this version opens formats ${data.accepts.join(', ')} only`);
  }
  const irreversible = data.migration === 'irreversible';
  if (irreversible && !confirmIrreversibleMigration) {
    throw appConflict('migration_confirmation_required',
      `This version converts the app data from format ${currentFormat} to ${data.format} and cannot convert it back; confirm the migration separately`);
  }
  return {
    dataFormat: data.format,
    migration: { from: currentFormat, to: data.format, irreversible,
      ...(irreversible ? { note: 'Rolling back code does not restore the earlier data format.' } : {}) }
  };
}
