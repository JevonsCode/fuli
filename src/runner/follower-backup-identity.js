import { localGraphSpaceId } from './local-graph-projects.js';
import { openRoutes } from './call-routes.js';
import { GLOBAL_SCOPE, ownerFingerprint } from './routes-store.js';
import { ownIssuer } from './task-issuer.js';

export function followerBackupIdentity(paths) {
  const routes = openRoutes(paths.dataDir);
  try {
    const followsHost = ownerFingerprint(routes.owner(GLOBAL_SCOPE));
    const computer = ownIssuer(paths.dataDir);
    const personalSpaceId = localGraphSpaceId(paths.graphRuntimeConfigPath);
    if (!computer || !followsHost || !personalSpaceId) throw new Error('Cannot identify this computer, host and personal space.');
    return { computer, followsHost, personalSpaceId };
  } finally { routes.close(); }
}

export function requireOwnBackup(manifest, identity) {
  if (manifest.computer !== identity.computer || manifest.followsHost !== identity.followsHost
    || manifest.selection?.personalSpaceId !== identity.personalSpaceId
    || manifest.instances.some(item => item.id !== 'personal')) {
    throw Object.assign(new Error('Choose a backup from this computer, its current host and its current personal space.'),
      { code: 'backup_from_another_computer' });
  }
}
