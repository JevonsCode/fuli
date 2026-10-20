import { readModelBackendConfig } from './config.js';
import { createModelBackendPort } from './port.js';
import { createModelSecretStore } from './secret-store.js';
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
