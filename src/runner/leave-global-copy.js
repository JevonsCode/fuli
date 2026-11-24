import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { stopGraphProviders } from '../setup/graph-runtime.js';
import { setGraphAside } from './follower-graph-aside.js';
import { forgetFollowerRuntime, holdPreparationLock, readRecord } from './follower-local-runtime.js';
import { COPY_FILE } from './global-copy-state.js';
import { localGraphOwnGlobal, localGraphProjects, localGraphSpaceId } from './local-graph-projects.js';
import { GLOBAL_SCOPE, LOCAL_OWNER, ROUTES_FILE, RoutesStore } from './routes-store.js';

// What happens to the host's copy of `global` at `fuli runner leave`
// (docs/runner-roles-design.md §12 "The sync loop"). After leave this data
// directory is a FULI of its own, whose Provider writes the defaults of
// `global` at its start, under the same IDs as the host's copies of them: the
// two would collide. A follower owns no scope yet, so its graph holds nothing
// but that copy: the whole graph is set aside, never deleted, in
// native-runtime/recovered/<time>/ with a note (follower-graph-aside.js), and
// the next start makes a graph of this computer's own, as a first start does.
// A graph no copy ever arrived in is left as it is.
//
// A graph that holds anything of this computer's own is never moved whole
// (ownDataHere): a scope routed here, or a project or a record of `global`
// besides the copy and the defaults, as its own Provider counts them when it
// runs, else as the last preparation found them. None can be there today (a
// follower owns no scope yet); the step that lets it own one must set aside
// only the copy instead.
//
// Answers { folder } when it set one aside, null when there was none. Throws
// (with a code) when it cannot now, before anything moved: a preparation holds
// the runtime (local_runtime_preparing), the graph holds data of this computer's
// own (local_data_here), or the move failed.
const WHY = 'This computer followed another FULI and kept a read-only copy of that computer\'s global (habits, '
  + 'the FLA roster) in this graph; it owned nothing in it. Set aside, not deleted, when it stopped following, so '
  + 'that a graph of its own can be made. '
  + '这台电脑之前跟随另一台 FULI，这个图谱里是那台电脑全局（习惯、助手名册）的只读副本，没有这台电脑自己的东西。'
  + '停止跟随时挪到这里，没有删除，好让这台电脑重新建自己的图谱。';

export async function setAsideHostCopy(paths, { env = process.env, now = Date.now, hold = holdPreparationLock,
  stop = stopGraphProviders, setAside = setGraphAside, ownData = ownDataHere } = {}) {
  const routes = new RoutesStore(join(paths.dataDir, ROUTES_FILE));
  let copied;
  let localRoutes;
  try {
    copied = routes.hasReplica(GLOBAL_SCOPE);
    localRoutes = routes.all().filter((row) => row.owner === LOCAL_OWNER).map((row) => row.scope);
  } finally { routes.close(); }
  if (!copied) return null;
  const own = await ownData(paths, { localRoutes });
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
    return { folder: aside.folder };
  } finally {
    release();
  }
}

// What of this computer's own the graph holds, said briefly, or null: scopes routed here, then
// its Provider's own count when it runs (localGraphProjects, localGraphOwnGlobal), else the last
// preparation's record of them (follower-local-runtime.js). Nothing is started to ask.
export async function ownDataHere(paths, { localRoutes = [], projects = localGraphProjects, ownGlobal = localGraphOwnGlobal,
  record = readRecord } = {}) {
  if (localRoutes.length) return `scopes routed to this computer: ${localRoutes.join(', ')}`;
  const config = paths.graphRuntimeConfigPath;
  const listed = await projects(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true }));
  const counted = listed.projects ? await ownGlobal(config, { timeoutMs: 3000 }).catch(() => ({ unreachable: true })) : null;
  const kept = record(paths.dataDir);
  const found = listed.projects ?? (Array.isArray(kept?.projects) ? kept.projects : []);
  const records = Number.isInteger(counted?.count) ? counted.count : Number.isInteger(kept?.ownGlobal) ? kept.ownGlobal : 0;
  if (found.length) return `${found.length} project(s)`;
  if (records > 0) return `${records} record(s) of global`;
  return null;
}
