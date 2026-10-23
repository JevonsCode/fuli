import { readModelBackendConfig } from './config.js';
import { createModelBackendPort } from './port.js';
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

// The session bridge over that port. resumers maps a role to the operation
// that uses a submitted answer; verifySession resolves the calling session.
export function openRoleWorkRuntime(paths, { port, verifySession, resumers }) {
  return createRoleWorkBridge({ port, store: new RoleWorkStore(paths.roleWorkPath), verifySession, resumers });
}

// What the built-in Agents showed after asking their own model, for the console.
export function openRoleSuggestionLog(paths) {
  return new RoleSuggestionLog(paths.roleSuggestionsPath);
}
