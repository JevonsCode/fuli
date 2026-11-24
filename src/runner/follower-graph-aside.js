import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rmdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { diskFree, diskSize, recoveryFolder, recoveryStamp, setAsideInto } from '../native-runtime/recovered-dir.js';
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
const OWN_SPACE_WHY = 'This computer made this graph itself under a space ID of its own, before it took the space ID of the '
  + 'computer it follows. Nothing of the person\'s was in it (no project, nothing in global besides the defaults '
  + 'FULI makes by itself). Kept, not deleted. '
  + '这台电脑跟随主机之前，用自己的空间 ID 建过这个图谱；里面没有你的东西（没有项目，全局里也只有 FULI 自己建的默认记录）。'
  + '留着，没有删除。';
const CONFIG = 'graph-runtime.json';

// Neo4j and the Provider are stopped first. Answers { folder, restore }:
// restore() puts the graph back where it was, with whatever a failed attempt
// made in its place set aside beside it, so the preparation can be tried again.
// When the settings cannot be moved after the instance was (a file held open
// on Windows), the instance goes back before the error is thrown: settings
// never name an empty place. moveFile: for a test to make a move fail.
// kind and why: what the note says it is, when it is not that empty graph (a graph holding only
// the host's copy of global, set aside at `fuli runner leave`, leave-global-copy.js).
export async function setGraphAside(paths, at, { spaceId, hostSpaceId, kind = 'follower-own-space', why = OWN_SPACE_WHY },
  { moveFile = rename } = {}) {
  const root = paths.nativeRuntimeDir;
  const folder = recoveryFolder(root, recoveryStamp(at));
  const instance = await setAsideInto(root, folder, paths.nativePersonalDir);
  const config = join(folder, CONFIG);
  try {
    await moveFile(paths.graphRuntimeConfigPath, config);
  } catch (error) {
    if (instance) await rename(instance, paths.nativePersonalDir);
    await rmdir(folder).catch(() => {});
    throw error;
  }
  writeJsonFileAtomic(join(folder, NOTE), { kind, setAsideAt: new Date(at).toISOString(),
    spaceId, hostSpaceId, why,
    // To use it again: with FULI quit, the two moves back. Folders, not a command.
    putBack: { instance: instance ? { from: instance, to: paths.nativePersonalDir } : null,
      settings: { from: config, to: paths.graphRuntimeConfigPath },
      how: 'Quit FULI on this computer, move the graph now in its place aside, then move this folder\'s instance '
        + 'directory back to the "to" place and graph-runtime.json back to its "to" place. '
        + '要再用它：先退出这台电脑上的 FULI，把现在原位置上的图谱挪开，再把这个目录里的实例目录挪回「to」所写的位置，'
        + 'graph-runtime.json 挪回它的「to」位置。' } });
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

export async function copyGraphBeforeRelease(paths, at, { free = diskFree } = {}) {
  const root = paths.nativeRuntimeDir;
  const folder = recoveryFolder(root, recoveryStamp(at));
  const needed = diskSize(paths.nativePersonalDir) + diskSize(paths.graphRuntimeConfigPath);
  if (await free(root) < needed) {
    throw Object.assign(new Error('Not enough free disk space for the full graph copy before leaving.'),
      { code: 'disk_low' });
  }
  await mkdir(dirname(folder), { recursive: true, mode: 0o700 });
  await mkdir(folder, { mode: 0o700 });
  const saved = join(folder, relative(root, paths.nativePersonalDir));
  await cp(paths.nativePersonalDir, saved, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await cp(paths.graphRuntimeConfigPath, join(folder, CONFIG));
  writeJsonFileAtomic(join(folder, NOTE), { kind: 'before-replica-release', copiedAt: new Date(at).toISOString(),
    why: 'Full offline graph copy before the host replica was released.' });
  return { folder };
}
