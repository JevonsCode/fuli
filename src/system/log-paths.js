import { nativeInstanceLogPaths } from '../setup/paths.js';

// Its own module so readers of the log files (the old-data list an Agent may
// read) do not load the console's log retention timer and cleanup.
/** Where FULI writes its logs: the console's, and each native graph instance's provider and Neo4j console. */
export function fuliLogPaths(paths) {
  return [paths.logPath, ...[paths.nativePersonalDir, paths.nativeWorkspaceDir].filter(Boolean).flatMap((instanceDir) => {
    const logs = nativeInstanceLogPaths(instanceDir);
    return [logs.provider, logs.database];
  })].filter(Boolean);
}
