import { readModelBackendConfig } from './config.js';
import { createModelBackendPort } from './port.js';
import { createRoleTrust } from './role-trust.js';
import { createRoleWorkBridge } from './role-work.js';
import { RoleWorkStore } from './role-work-store.js';
import { createModelSecretStore } from './secret-store.js';
import { createModelSettingsHistory } from './settings-history.js';
import { RoleSuggestionLog } from './suggestion-log.js';
import { ModelUsageLedger } from './usage-ledger.js';

// Composition of the model port for one FULI data directory. The config is
// read on every call, so a saved change applies without a restart.
// Keys saved before they were tied to an endpoint are tied once here (secret-store.js bindLegacyKeys).
export function openModelBackendRuntime(paths) {
  const readConfig = () => readModelBackendConfig(paths.modelBackendConfigPath);
  const secrets = createModelSecretStore({ path: paths.modelSecretStorePath });
  const loaded = readConfig();
  try {
    if (loaded.state === 'ok') secrets.bindLegacyKeys(loaded.config.connections);
  } catch (error) {
    console.warn(`Model keys were not tied to their endpoints: ${error?.message ?? error}`);
  }
  return createModelBackendPort({
    readConfig,
    secrets,
    ledger: new ModelUsageLedger(paths.modelUsageLedgerPath)
  });
}

// Whether each role's configured model may carry out its operations by
// itself (rec#10 D-36), read over that port, and the history of what changed
// in it and in the model settings, and when (rec#11 D-42). The history is
// read against the current file and trust revisions.
export function openRoleTrustAndHistory(paths, port) {
  let trust = null;
  const history = createModelSettingsHistory({ path: paths.modelSettingsHistoryPath,
    readConfig: () => readModelBackendConfig(paths.modelBackendConfigPath), readTrustRevision: role => trust.revision(role) });
  trust = createRoleTrust({ path: paths.modelTrustPath, modelBackends: port, history });
  return { trust, history };
}

// The session bridge over that port. resumers maps a role to the operation
// that uses a submitted answer, views to what a session may read of its
// result, packageViews to what it receives of the work; verifySession
// resolves the calling session.
export function openRoleWorkRuntime(paths, { port, verifySession, resumers, views, packageViews, recoveryGate }) {
  return createRoleWorkBridge({ port, store: new RoleWorkStore(paths.roleWorkPath, { recoveryGate }), verifySession,
    resumers, views, packageViews,
    prepareStore: spaceId => recoveryGate?.refresh(spaceId) });
}

// What the built-in Agents showed after asking their own model, for the console.
export function openRoleSuggestionLog(paths, { recoveryGate } = {}) {
  return new RoleSuggestionLog(paths.roleSuggestionsPath, { recoveryGate });
}
