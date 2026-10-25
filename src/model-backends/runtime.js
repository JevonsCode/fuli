import { readModelBackendConfig } from './config.js';
import { createModelBackendPort } from './port.js';
import { createRoleTrust } from './role-trust.js';
import { createRoleWorkBridge } from './role-work.js';
import { RoleWorkStore } from './role-work-store.js';
import { createModelSecretStore } from './secret-store.js';
import { RoleSuggestionLog } from './suggestion-log.js';
import { ModelUsageLedger } from './usage-ledger.js';

// Composition of the model port for one FULI data directory. The config is
// read on every call, so a saved change applies without a restart.
export function openModelBackendRuntime(paths) {
  return createModelBackendPort({
    readConfig: () => readModelBackendConfig(paths.modelBackendConfigPath),
    secrets: createModelSecretStore({ path: paths.modelSecretStorePath }),
    ledger: new ModelUsageLedger(paths.modelUsageLedgerPath)
  });
}

// Whether each role's configured model may carry out its operations by
// itself (rec#10 D-36), read over that port.
export function openRoleTrust(paths, port) {
  return createRoleTrust({ path: paths.modelTrustPath, modelBackends: port });
}

// The session bridge over that port. resumers maps a role to the operation
// that uses a submitted answer, views to what a session may read of its
// result; verifySession resolves the calling session.
export function openRoleWorkRuntime(paths, { port, verifySession, resumers, views, recoveryGate }) {
  return createRoleWorkBridge({ port, store: new RoleWorkStore(paths.roleWorkPath, { recoveryGate }), verifySession, resumers, views,
    prepareStore: spaceId => recoveryGate?.refresh(spaceId) });
}

// What the built-in Agents showed after asking their own model, for the console.
export function openRoleSuggestionLog(paths, { recoveryGate } = {}) {
  return new RoleSuggestionLog(paths.roleSuggestionsPath, { recoveryGate });
}
