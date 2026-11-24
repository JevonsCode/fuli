import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { stopGraphProviders } from '../setup/graph-runtime.js';
import { setGraphAside } from './follower-graph-aside.js';
import { forgetFollowerRuntime, holdPreparationLock } from './follower-local-runtime.js';
import { COPY_FILE } from './global-copy-state.js';
import { localGraphSpaceId } from './local-graph-projects.js';
import { GLOBAL_SCOPE, ROUTES_FILE, RoutesStore } from './routes-store.js';

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
// Answers { folder } when it set one aside, null when there was none. Throws
// (with a code) when it cannot now, before anything moved: a preparation holds
// the runtime (local_runtime_preparing), or the move failed.
const WHY = 'This computer followed another FULI and kept a read-only copy of that computer\'s global (habits, '
  + 'the FLA roster) in this graph; it owned nothing in it. Set aside, not deleted, when it stopped following, so '
  + 'that a graph of its own can be made. '
  + '这台电脑之前跟随另一台 FULI，这个图谱里是那台电脑全局（习惯、助手名册）的只读副本，没有这台电脑自己的东西。'
  + '停止跟随时挪到这里，没有删除，好让这台电脑重新建自己的图谱。';

export async function setAsideHostCopy(paths, { env = process.env, now = Date.now, hold = holdPreparationLock,
  stop = stopGraphProviders, setAside = setGraphAside } = {}) {
  const routes = new RoutesStore(join(paths.dataDir, ROUTES_FILE));
  let copied;
  try { copied = routes.hasReplica(GLOBAL_SCOPE); } finally { routes.close(); }
  if (!copied) return null;
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
