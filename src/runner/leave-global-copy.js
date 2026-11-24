import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { stopGraphProviders } from '../setup/graph-runtime.js';
import { createNativeGraphServices } from '../native-runtime/runtime.js';
import { OWNED_PROJECT_MARKER } from './owned-project-routes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { copyGraphBeforeRelease, setGraphAside, wholeCopyBeforeRelease } from './follower-graph-aside.js';
import { forgetFollowerRuntime, holdPreparationLock, readRecord } from './follower-local-runtime.js';
import { COPY_FILE } from './global-copy-state.js';
import { localGraphOwnGlobal, localGraphProjects, localGraphRelease, localGraphSpaceId, localGraphWaitingRecruitments }
  from './local-graph-projects.js';
import { GLOBAL_SCOPE, LOCAL_OWNER, ownerFingerprint, PROJECT_PREFIX, ROUTES_FILE, RoutesStore } from './routes-store.js';

// A copy-only graph can be moved aside. A computer with a local project keeps
// its working graph: take a full offline copy, release the former host's
// records in the Provider, then stop replica mode before ending the pairing.
// The preparation lock covers all these steps, including the pairing change.
const WHY = 'This computer followed another FULI and kept a read-only copy of that computer\'s global (habits, '
  + 'the FLA roster) in this graph; it owned nothing in it. Set aside, not deleted, when it stopped following, so '
  + 'that a graph of its own can be made. '
  + '这台电脑之前跟随另一台 FULI，这个图谱里是那台电脑全局（习惯、助手名册）的只读副本，没有这台电脑自己的东西。'
  + '停止跟随时挪到这里，没有删除，好让这台电脑重新建自己的图谱。';
// The full copy a leave made before its release, kept while the release has not succeeded.
const LEAVE_COPY_FILE = join('runner', 'leave-copy.json');
const LEAVE_COPY_REUSE_MS = 60 * 60_000;

export async function setAsideHostCopy(paths, { env = process.env, now = Date.now, hold = holdPreparationLock,
  stop = stopGraphProviders, setAside = setGraphAside, ownData = ownDataHere, copy = copyGraphBeforeRelease,
  restart = (options) => createNativeGraphServices(options).start(), releaseScope = localGraphRelease,
  waitingRecruitments = localGraphWaitingRecruitments, finish = () => {} } = {}) {
  const routes = new RoutesStore(join(paths.dataDir, ROUTES_FILE));
  let localRoutes, owner, copied;
  try {
    copied = routes.hasReplica(GLOBAL_SCOPE);
    owner = ownerFingerprint(routes.owner(GLOBAL_SCOPE));
    localRoutes = routes.all().filter(row => row.owner === LOCAL_OWNER).map(row => row.scope);
  } finally { routes.close(); }
  // Data of this computer's own: a scope routed here now, or the mark the first one left
  // (make-project-local.js). A route that only pins a project to the host is not one.
  const marker = join(paths.dataDir, OWNED_PROJECT_MARKER);
  if (!localRoutes.some(scope => scope.startsWith(PROJECT_PREFIX)) && !existsSync(marker)) {
    return setAsideWhole(paths, { copied, localRoutes, env, now, hold, stop, setAside, ownData, finish });
  }
  const release = hold(paths.dataDir, { waitMs: 0 });
  if (!release) {
    throw Object.assign(new Error('This computer’s graph is being prepared or synced; try leaving after it finishes.'),
      { code: 'local_runtime_preparing' });
  }
  try {
    await ownData(paths, { localRoutes, requireLive: true });
    if (!owner) throw new Error('The owner of the copy is unknown.');
    const recruitments = await waitingRecruitments(paths.graphRuntimeConfigPath).catch(() => null);
    const halt = () => stop(paths, paths.graphEnvPath, { runtimeMode: 'native', personalOnly: true, env });
    // A leave tried again after its release failed keeps the full copy it already made, when that
    // copy is still whole (follower-graph-aside.js); every other leave makes one first.
    const pendingPath = join(paths.dataDir, LEAVE_COPY_FILE);
    const pending = readJsonFile(pendingPath, null);
    let saved = pending?.owner === owner && now() - Date.parse(pending.at) < LEAVE_COPY_REUSE_MS
      && typeof pending.folder === 'string' ? wholeCopyBeforeRelease(pending.folder) : null;
    if (!saved) {
      await halt();
      try { saved = await copy(paths, now()); }
      finally { await restart({ paths, env, personalOnly: true }); }
      writeJsonFileAtomic(pendingPath, { owner, folder: saved.folder, at: new Date(now()).toISOString() });
    }
    const result = await releaseScope(paths.graphRuntimeConfigPath, owner);
    if (result.unreachable || (result.refused && result.code !== 'replica_not_held')) {
      throw Object.assign(new Error(result.message ?? 'The local Provider did not confirm release of the copy.'),
        { code: result.code ?? 'release_unconfirmed' });
    }
    await halt();
    forgetFollowerRuntime(paths.dataDir);
    rmSync(join(paths.dataDir, COPY_FILE), { force: true });
    finish(true);
    // Left: nothing of a host is kept here any more, so a later pairing starts as a first one does.
    rmSync(pendingPath, { force: true });
    rmSync(marker, { force: true });
    return { folder: saved.folder, released: true,
      waitingRecruitments: Number.isInteger(recruitments?.count) ? recruitments.count : null };
  } finally {
    release();
  }
}

// A follower that owns nothing here, as before this computer could own a project: a graph
// holding only the host's copy of global is set aside whole, never deleted; a graph no copy
// ever arrived in is left as it is; one holding data of its own is not moved.
async function setAsideWhole(paths, { copied, localRoutes, env, now, hold, stop, setAside, ownData, finish }) {
  if (!copied) { finish(false); return null; }
  const own = await ownData(paths, { localRoutes, requireLive: false });
  if (own) {
    throw Object.assign(new Error(`This computer's graph holds data of its own besides the host's copy (${own}), so it is `
      + 'not set aside whole; nothing was changed. 这台电脑的图谱里除了主机的副本还有自己的数据'
      + `（${own}），所以没有整份挪走，什么都没改。`), { code: 'local_data_here' });
  }
  const release = hold(paths.dataDir, { waitMs: 0 });
  if (!release) {
    throw Object.assign(new Error('This computer\'s own runtime is being prepared or synced now; leave again once it is done.'),
      { code: 'local_runtime_preparing' });
  }
  try {
    await stop(paths, paths.graphEnvPath, { runtimeMode: 'native', personalOnly: true, env });
    const aside = await setAside(paths, now(), { spaceId: localGraphSpaceId(paths.graphRuntimeConfigPath),
      hostSpaceId: null, kind: 'follower-host-copy', why: WHY });
    forgetFollowerRuntime(paths.dataDir);
    rmSync(join(paths.dataDir, COPY_FILE), { force: true });
    finish(false);
    return { folder: aside.folder };
  } finally {
    release();
  }
}

// What of this computer's own the graph holds, said briefly, or null: scopes routed here, then
// its Provider's own count when it runs (localGraphProjects, localGraphOwnGlobal), else the last
// preparation's record of them (follower-local-runtime.js). Nothing is started to ask.
export async function ownDataHere(paths, { localRoutes = [], requireLive = localRoutes.length > 0, projects = localGraphProjects, ownGlobal = localGraphOwnGlobal,
  record = readRecord } = {}) {
  if (localRoutes.length && !requireLive) return `scopes routed to this computer: ${localRoutes.join(', ')}`;
  const config = paths.graphRuntimeConfigPath;
  const listed = await projects(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true }));
  const counted = listed.projects ? await ownGlobal(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true })) : null;
  // A computer that owns projects is never judged by an earlier record: its graph must answer now.
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
