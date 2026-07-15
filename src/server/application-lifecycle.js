import { createApplication } from '../app/create-application.js';
import { openLocalApplication } from '../runtime-options.js';

export function createServerApplication({
  app,
  store,
  dbPath,
  personalSpaceName,
  closeApplicationOnShutdown
}) {
  const application = app ?? (store
    ? createApplication({ store, activePersonalSpaceName: personalSpaceName })
    : openLocalApplication({ dbPath, personalSpaceName }));
  const owned = closeApplicationOnShutdown ?? (!app && !store);
  return {
    application,
    close: closeOnce(() => {
      if (owned) application.close();
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
