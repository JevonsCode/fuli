import { existsSync } from 'node:fs';

import { createCaptureOnboarding } from '../graphiti/capture-onboarding.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../graphiti/capture-policy.js';

// A new installation's question about where FULI records (rec#5 C10), for the
// data directory setup or start uses.
export function captureOnboardingFor(paths) {
  return createCaptureOnboarding(capturePolicyStoreFor(paths));
}

// Opens the question only when FULI is about to create its data here for the
// first time, before the graph starts or any Agent connects, so nothing is
// recorded before the person answers. Any sign of an earlier installation
// counts against it: a graph runtime configuration (every installation that
// ever ran writes one) or a saved one for either runtime mode, capture
// settings saved by any version, or a native graph's data. When unsure the
// installation is treated as existing and keeps its settings.
export function beginFirstRunCapture(paths) {
  const store = capturePolicyStoreFor(paths);
  const earlier = [paths.graphRuntimeConfigPath, paths.containerGraphConfigProfilePath,
    paths.nativeGraphConfigProfilePath, paths.nativePersonalDir].filter(Boolean).some(path => existsSync(path));
  if (!earlier && store.neverSaved()) createCaptureOnboarding(store).begin();
}

function capturePolicyStoreFor(paths) {
  return new CapturePolicyStore(capturePolicyPathForRuntime(paths.graphRuntimeConfigPath));
}
