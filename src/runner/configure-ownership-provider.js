import { createManagedGraphServices } from '../adaptive-runtime/graph-services.js';
import { unfinishedImportError } from '../backup/unfinished-import.js';
import { readJsonFile } from '../storage/json-file.js';

// An existing managed container needs its new control bind mount before it
// can attest to this installation. Native Providers already know the path.
export async function configureOwnershipProvider(paths, { read = readJsonFile, services = createManagedGraphServices,
  unfinished = unfinishedImportError } = {}) {
  const active = read(paths.graphRuntimeStatePath, null);
  if (active?.runtimeSettings?.graphRuntimeMode !== 'container' || !active.managedProviders?.includes('personal')) return;
  const blocked = unfinished(paths, 'container');
  if (blocked) throw blocked;
  await services({ paths }).configurePersonal();
}
