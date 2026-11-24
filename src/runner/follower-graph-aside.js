import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { recoveryFolder, recoveryStamp, setAsideInto } from '../native-runtime/recovered-dir.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';

// A follower's own graph that an earlier preparation made under a space ID of
// its own, with nothing of the person's in it, is set aside, never deleted,
// before the graph is made again under the host's space ID
// (follower-runtime-prepare.js). The whole personal instance directory (its
// databases, transaction logs, settings and logs) and the graph-runtime.json
// that names it go to native-runtime/recovered/<time>/, where every set-aside
// graph of this data directory is found (recovered-dir.js graphDataFolders):
// a person deletes it, nothing else does. NOTE says what it is.
const NOTE = 'follower-space.json';
const CONFIG = 'graph-runtime.json';

// Neo4j and the Provider are stopped first. Answers { folder, restore }:
// restore() puts the graph back where it was, with whatever a failed attempt
// made in its place set aside beside it, so the preparation can be tried again.
export async function setGraphAside(paths, at, { spaceId, hostSpaceId }) {
  const root = paths.nativeRuntimeDir;
  const folder = recoveryFolder(root, recoveryStamp(at));
  const instance = await setAsideInto(root, folder, paths.nativePersonalDir);
  const config = join(folder, CONFIG);
  await rename(paths.graphRuntimeConfigPath, config);
  writeJsonFileAtomic(join(folder, NOTE), { kind: 'follower-own-space', setAsideAt: new Date(at).toISOString(),
    spaceId, hostSpaceId, why: 'This computer made this graph itself under a space ID of its own, before it took the '
      + 'space ID of the computer it follows. Nothing of the person\'s was in it (no project). Kept, not deleted.' });
  return {
    folder,
    async restore() {
      const attempt = join(folder, 'attempt');
      await mkdir(attempt, { recursive: true, mode: 0o700 });
      await setAsideInto(root, attempt, paths.nativePersonalDir);
      if (existsSync(paths.graphRuntimeConfigPath)) await rename(paths.graphRuntimeConfigPath, join(attempt, CONFIG));
      if (instance) await rename(instance, paths.nativePersonalDir);
      await rename(config, paths.graphRuntimeConfigPath);
    }
  };
}
