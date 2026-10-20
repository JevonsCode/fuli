import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { approvalBinds, tamperedPackage, unavailablePermissions } from './authorization.js';
import { appConflict } from './errors.js';
import { storedPackageMatches } from './package-files.js';

const TOKEN_PREFIX = 'fla_';
const TOKEN_BYTES = 32;

// The App Host port: an app proves who it is with a token issued for its active,
// approved version. The token carries exactly that version's permissions and
// ends when the version stops being the running one. Only token hashes are kept.
export function createAppTokens(context) {
  const { store, now } = context;

  function issueToken({ appId }) {
    const outcome = store.transaction(() => {
      const app = store.existingApp(appId);
      if (app.status !== 'active') {
        return { refusal: appConflict('app_not_active', 'Only an active app with an approved version receives an app token') };
      }
      const running = runningVersion(app);
      if (running.refusal) return running;
      const at = now();
      store.revokeTokens(appId, 'reissued', at);
      const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
      const { version, digest, permissions } = running.grant;
      store.insertToken({ tokenHash: contentHash(token), appId, version, digest, permissions, issuedAt: at });
      return { result: { token, appId, version, permissions } };
    });
    if (outcome.refusal) throw outcome.refusal;
    return outcome.result;
  }

  // toolName: the FULI tool the app is about to call, checked against its grant.
  function verifyToken({ token, toolName = null }) {
    const outcome = store.transaction(() => {
      const issued = typeof token === 'string' && token.startsWith(TOKEN_PREFIX) ? store.token(contentHash(token)) : null;
      const app = issued && !issued.revokedAt ? store.app(issued.appId) : null;
      if (!app || app.status !== 'active' || app.activeVersion !== issued.version) {
        return { refusal: new ApplicationError('app_token_invalid', 'This app token is unknown or no longer valid', { status: 401 }) };
      }
      const running = runningVersion(app);
      if (running.refusal) return running;
      if (toolName !== null && !issued.permissions.includes(`fuli.${toolName}`)) {
        return { refusal: new ApplicationError('tool_not_permitted', `This app version may not call ${toolName}`, { status: 403 }) };
      }
      const at = now();
      store.saveApp({ ...app, lastUsedAt: at });
      return { result: { appId: app.appId, version: issued.version, personalSpaceId: app.personalSpaceId,
        agentId: app.agentId, permissions: issued.permissions } };
    });
    if (outcome.refusal) throw outcome.refusal;
    return outcome.result;
  }

  // A refusal is returned rather than thrown so that ending the tokens of a
  // tampered package commits before the caller sees the error.
  function runningVersion(app) {
    const version = store.version(app.appId, app.activeVersion);
    const approval = store.approval(app.appId, app.activeVersion);
    if (!approvalBinds(approval, version)) {
      return { refusal: appConflict('approval_mismatch', 'The approval does not cover the running package') };
    }
    if (!storedPackageMatches(context.packageOf(app.appId, version.version), approval.digest)) {
      const at = now();
      store.revokeTokens(app.appId, 'package_tampered', at);
      store.recordEvent({ appId: app.appId, at, action: 'tamper_detected', version: version.version });
      return { refusal: tamperedPackage() };
    }
    const refusal = unavailablePermissions(approval.permissions, context.grantable());
    if (refusal) return { refusal };
    return { grant: { version: version.version, digest: approval.digest, permissions: approval.permissions } };
  }

  return { issueToken, verifyToken };
}
