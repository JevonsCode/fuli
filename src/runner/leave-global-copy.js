import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { stopGraphProviders } from '../setup/graph-runtime.js';
import { createNativeGraphServices } from '../native-runtime/runtime.js';
import { OWNED_PROJECT_MARKER } from './owned-project-routes.js';
import { copyGraphBeforeRelease, setGraphAside } from './follower-graph-aside.js';
import { forgetFollowerRuntime, holdPreparationLock, readRecord } from './follower-local-runtime.js';
import { COPY_FILE } from './global-copy-state.js';
import { localGraphOwnGlobal, localGraphProjects, localGraphRelease, localGraphSpaceId } from './local-graph-projects.js';
import { GLOBAL_SCOPE, LOCAL_OWNER, ownerFingerprint, ROUTES_FILE, RoutesStore } from './routes-store.js';

// A copy-only graph can be moved aside. A computer with a local project keeps
// its working graph: take a full offline copy, release the former host's
// records in the Provider, then stop replica mode before ending the pairing.
// The preparation lock covers all these steps, including the pairing change.
const WHY = 'This computer followed another FULI and kept a read-only copy of that computer\'s global (habits, '
  + 'the FLA roster) in this graph; it owned nothing in it. Set aside, not deleted, when it stopped following, so '
  + 'that a graph of its own can be made. '
  + '这台电脑之前跟随另一台 FULI，这个图谱里是那台电脑全局（习惯、助手名册）的只读副本，没有这台电脑自己的东西。'
  + '停止跟随时挪到这里，没有删除，好让这台电脑重新建自己的图谱。';

export async function setAsideHostCopy(paths, { env = process.env, now = Date.now, hold = holdPreparationLock,
  stop = stopGraphProviders, setAside = setGraphAside, ownData = ownDataHere, copy = copyGraphBeforeRelease,
  restart = (options) => createNativeGraphServices(options).start(), releaseScope = localGraphRelease, finish = () => {} } = {}) {
  const release = hold(paths.dataDir, { waitMs: 0 });
  if (!release) {
    throw Object.assign(new Error('This computer’s graph is being prepared or synced; try leaving after it finishes.'),
      { code: 'local_runtime_preparing' });
  }
  try {
    const routes = new RoutesStore(join(paths.dataDir, ROUTES_FILE));
    let localRoutes, owner, copied, projectRoutes;
    try {
      copied = routes.hasReplica(GLOBAL_SCOPE);
      owner = ownerFingerprint(routes.owner(GLOBAL_SCOPE));
      projectRoutes = routes.all().filter(row => row.scope.startsWith('project:'));
      localRoutes = projectRoutes.filter(row => row.owner === LOCAL_OWNER).map(row => row.scope);
    } finally { routes.close(); }
    const recordedAt = Date.parse(readRecord(paths.dataDir)?.at ?? '');
    const hadLocal = localRoutes.length > 0 || existsSync(join(paths.dataDir, OWNED_PROJECT_MARKER))
      || projectRoutes.some(row => !Number.isFinite(recordedAt) || Date.parse(row.updatedAt) > recordedAt);
    if (!copied && !hadLocal) { finish(); return null; }
    const own = await ownData(paths, { localRoutes, requireLive: hadLocal });
    if (own && !hadLocal) {
      throw Object.assign(new Error(`This computer’s graph holds its own data (${own}); it cannot be set aside whole.`),
        { code: 'local_data_here' });
    }
    const halt = () => stop(paths, paths.graphEnvPath, { runtimeMode: 'native', personalOnly: true, env });
    if (hadLocal && !owner) throw new Error('The owner of the copy is unknown.');
    await halt();
    let aside;
    if (hadLocal) {
      let saved;
      try { saved = await copy(paths, now()); }
      finally { await restart({ paths, env, personalOnly: true }); }
      const result = await releaseScope(paths.graphRuntimeConfigPath, owner);
      if (result.unreachable || (result.refused && result.code !== 'replica_not_held')) {
        throw Object.assign(new Error(result.message ?? 'The local Provider did not confirm release of the copy.'),
          { code: result.code ?? 'release_unconfirmed' });
      }
      await halt();
      aside = { folder: saved.folder, released: true };
    } else {
      aside = await setAside(paths, now(), { spaceId: localGraphSpaceId(paths.graphRuntimeConfigPath),
        hostSpaceId: null, kind: 'follower-host-copy', why: WHY });
    }
    forgetFollowerRuntime(paths.dataDir);
    rmSync(join(paths.dataDir, COPY_FILE), { force: true });
    finish(aside.released === true);
    return aside.released ? aside : { folder: aside.folder };
  } finally {
    release();
  }
}

// What of this computer's own the graph holds, said briefly, or null: scopes routed here, then
// its Provider's own count when it runs (localGraphProjects, localGraphOwnGlobal), else the last
// preparation's record of them (follower-local-runtime.js). Nothing is started to ask.
export async function ownDataHere(paths, { localRoutes = [], requireLive = localRoutes.length > 0, projects = localGraphProjects, ownGlobal = localGraphOwnGlobal,
  record = readRecord } = {}) {
  const config = paths.graphRuntimeConfigPath;
  const listed = await projects(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true }));
  const counted = listed.projects ? await ownGlobal(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true })) : null;
  if (requireLive && (!Array.isArray(listed.projects) || !Number.isInteger(counted?.count))) {
    throw Object.assign(new Error('看不到这台电脑的图里有什么，先启动 FULI 再离开。 / Start FULI so it can check this computer’s data before leaving.'),
      { code: 'own_data_unknown' });
  }
  if (localRoutes.length) return `scopes routed to this computer: ${localRoutes.join(', ')}`;
  const kept = record(paths.dataDir);
  const found = listed.projects ?? (Array.isArray(kept?.projects) ? kept.projects : []);
  const records = Number.isInteger(counted?.count) ? counted.count : Number.isInteger(kept?.ownGlobal) ? kept.ownGlobal : 0;
  if (found.length) return `${found.length} project(s)`;
  if (records > 0) return `${records} record(s) of global`;
  return null;
}
