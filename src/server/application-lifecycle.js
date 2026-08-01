import { openFederatedGraphApplication } from '../graphiti/federated-application.js';

export function createServerApplication({
  app,
  runtimeConfigPath,
  closeApplicationOnShutdown
}) {
  const application = app ?? openFederatedGraphApplication({ runtimeConfigPath });
  const owned = closeApplicationOnShutdown ?? !app;
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
