import { createApplication } from '../app/create-application.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { openLocalApplication } from '../runtime-options.js';

export function createServerApplication({
  app,
  store,
  dbPath,
  runtimeConfigPath,
  personalSpaceName,
  closeApplicationOnShutdown
}) {
  const application = app ?? (store
    ? createApplication({ store, activePersonalSpaceName: personalSpaceName })
    : dbPath
      ? openLocalApplication({ dbPath, personalSpaceName })
      : openFederatedGraphApplication({ runtimeConfigPath }));
  const owned = closeApplicationOnShutdown ?? (!app && !store);
  return {
    application,
    close: closeOnce(() => {
      if (owned) return application.close();
    })
  };
}

export function closeOnce(close) {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    return close();
  };
}
