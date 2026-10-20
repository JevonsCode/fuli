import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { appConflict } from './errors.js';

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
