import {
  inspectLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../local-runtime/lifecycle.js';
import { readRuntimeSettings, runtimeSettingsWithOverrides } from '../system/runtime-settings.js';
import { startupStageWriter } from '../local-runtime/startup-stage.js';
import { refuseOnFollower } from './follower-graph-refusal.js';

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
  return {
    async consoleRunning() {
      const state = await inspectLocalRuntime(input());
      return state.console?.status !== 'stopped';
    },
    stop: () => stopLocalRuntime(input()),
    start: async () => {
      refuseOnFollower(paths.dataDir, 'FULI start');
      return startLocalRuntime(input());
    }
  };
}
