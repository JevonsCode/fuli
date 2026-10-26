import { randomBytes } from 'node:crypto';

import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { ApplicationError } from '../app/application-error.js';
import { approvalBinds, tamperedPackage, unavailablePermissions } from './authorization.js';
import { appConflict } from './errors.js';
import { storedPackageMatches } from './package-files.js';

const TOKEN_PREFIX = 'fla_';
const TOKEN_BYTES = 32;

// App tokens: an instance proves which app, version and instance it is with a
// token issued when it started, for its active, approved version (rec#7
// D-28.14). The token carries exactly that version's permissions and names the
// instance id and generation; it ends when the version stops being the running
// one, and it verifies only while that instance is the app's current one and
// still running (sealing refuses every new call: app_sealed). Only token
// hashes are kept.
export function createAppTokens(context) {
  const { store, now } = context;

  // Inside the caller's transaction, which also records the instance.
  // A refusal is returned so that ending the tokens of a tampered package
  // commits before the caller throws it.
  function mintToken({ app, instanceId, generation }) {
    const running = runningVersion(app);
    if (running.refusal) return running;
    const at = now();
    store.revokeTokens(app.appId, 'reissued', at);
    const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const { version, digest, permissions } = running.grant;
    store.insertToken({ tokenHash: contentHash(token), appId: app.appId, version, digest, permissions,
      instanceId, generation, issuedAt: at });
    return { token, permissions };
  }

  // toolName: the FULI tool the app is about to call, checked against its grant.
  function verifyToken({ token, toolName = null }) {
    const outcome = store.transaction(() => {
      const issued = typeof token === 'string' && token.startsWith(TOKEN_PREFIX) ? store.token(contentHash(token)) : null;
      const app = issued && !issued.revokedAt ? store.app(issued.appId) : null;
      if (!app || app.status !== 'active' || app.activeVersion !== issued.version) {
        return { refusal: new ApplicationError('app_token_invalid', 'This app token is unknown or no longer valid', { status: 401 }) };
      }
      const instance = store.instance(app.appId);
      if (!instance || instance.instanceId !== issued.instanceId || instance.generation !== issued.generation) {
        return { refusal: appConflict('instance_superseded', 'This instance is no longer the app\'s current one') };
      }
      if (instance.state !== 'running') {
        return { refusal: appConflict('app_sealed', 'This app instance is being stopped and accepts no new calls') };
      }
      const running = runningVersion(app);
      if (running.refusal) return running;
      if (toolName !== null && !issued.permissions.includes(`fuli.${toolName}`)) {
        return { refusal: new ApplicationError('tool_not_permitted', `This app version may not call ${toolName}`, { status: 403 }) };
      }
      store.saveApp({ ...app, lastUsedAt: now() });
      return { result: { appId: app.appId, version: issued.version, personalSpaceId: app.personalSpaceId,
        agentId: app.agentId, permissions: issued.permissions, instanceId: instance.instanceId,
        generation: instance.generation } };
    });
    if (outcome.refusal) throw outcome.refusal;
    return outcome.result;
  }

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

  return { mintToken, verifyToken };
}
