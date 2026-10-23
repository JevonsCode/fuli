import { connectCodex } from '../../codex-config.js';
import { installCodexBootstrap } from '../../codex-bootstrap.js';
import { installCodexLifecycleHooks } from '../../../agents/codex/lifecycle-hooks.js';

// Render through the same writer and bootstrap/hook code, with every write captured.
export function previewCodexConfiguration(pack, agent, context, io) {
  return connectCodex(pack, agent, context, {
    readConfig: io.readText, writeConfig: io.writeText,
    readHooks: io.readJson, writeHooks: io.writeJson,
    installBootstrap: (target, instructions) => installCodexBootstrap(target, instructions, io),
    installHooks: (target, options) => installCodexLifecycleHooks(target, {
      ...options, readConfig: io.readJson, writeConfig: io.writeJson
    })
  });
}
