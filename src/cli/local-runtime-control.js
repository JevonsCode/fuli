import {
  inspectLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../local-runtime/lifecycle.js';
import { readRuntimeSettings, runtimeSettingsWithOverrides } from '../system/runtime-settings.js';
import { startupStageWriter } from '../local-runtime/startup-stage.js';
import { ownsLocalProjects } from '../runner/owned-project-routes.js';
import { followsHost, refuseOnFollower } from './follower-graph-refusal.js';

/**
 * Console state, stop and start for one data directory, for commands that
 * need the graph offline. Settings are read on every call because the
 * command itself may be the step that switched the runtime mode. On a
 * follower the start refuses (follower-graph-refusal.js): its console port is
 * the follower console's, and its graph is FULI's own to start.
 */
export function localRuntimeControl(paths, env, write) {
  const input = () => {
    const runtimeSettings = runtimeSettingsWithOverrides(readRuntimeSettings(paths.runtimeSettingsPath), {});
    return { paths, env, runtimeSettings, port: runtimeSettings.ports.console,
      lan: runtimeSettings.lanAccess, onProgress: write,
      onStage: startupStageWriter(write, env) };
  };
  async function follower() {
    if (!followsHost(paths.dataDir) || !ownsLocalProjects(paths.dataDir)) return null;
    const { followerRuntimeHandlers } = await import('../runner/follower-runtime.js');
    return followerRuntimeHandlers();
  }
  return {
    async consoleRunning() {
      const runner = await follower();
      if (runner) return (await runner.status(input())).status === 'running';
      const state = await inspectLocalRuntime(input());
      return state.console?.status !== 'stopped';
    },
    async stop() {
      const runner = await follower();
      return runner ? runner.stop(input()) : stopLocalRuntime(input());
    },
    start: async () => {
      const runner = await follower();
      if (runner) return runner.start(input());
      refuseOnFollower(paths.dataDir, 'FULI start');
      return startLocalRuntime(input());
    }
  };
}
