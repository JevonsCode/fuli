import { boundChildProcessLog, childLogArchives, removeChildLogArchives } from '../local-runtime/child-process-log.js';
import { fuliLogPaths } from './log-paths.js';

// The children write their logs while they run, so the console checks every
// few minutes that none has grown past its limit (child-process-log.js, REC #67).
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export { fuliLogPaths } from './log-paths.js';

// paths: resolveSetupPaths(). The kept copies are removed only when the person
// asks (「清理旧日志」); rotation alone drops only the oldest one.
export function createLogRetention({ paths, schedule = setInterval, cancel = clearInterval }) {
  const logs = fuliLogPaths(paths);
  const timer = schedule(() => {
    for (const path of logs) {
      try { boundChildProcessLog(path); } catch { /* the next check tries again */ }
    }
  }, CHECK_INTERVAL_MS);
  timer?.unref?.();
  return {
    archives: () => {
      const files = logs.flatMap(childLogArchives);
      return { files: files.length, bytes: files.reduce((sum, { bytes }) => sum + bytes, 0) };
    },
    clearArchives: () => ({ freedBytes: logs.reduce((sum, path) => sum + removeChildLogArchives(path), 0) }),
    close: () => cancel(timer)
  };
}
