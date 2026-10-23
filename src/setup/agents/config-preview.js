import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_WRITERS } from './config-writers.js';
import { previewCodexConfiguration } from './codex/config-preview.js';

// A preview is memory-only. No temporary client homes, no subprocesses, no writes.
export function previewClientConfiguration(pack, agent, context) {
  const before = new Map(); const after = new Map();
  const readText = path => {
    if (!before.has(path)) before.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
    return after.get(path) ?? before.get(path) ?? '';
  };
  const io = {
    fileExists: existsSync, readText,
    readJson: (path, fallback = {}) => { const text = readText(path); return text ? JSON.parse(text) : fallback; },
    writeText: (path, text) => { readText(path); after.set(path, text); },
    writeJson: (path, value) => io.writeText(path, `${JSON.stringify(value, null, 2)}\n`)
  };
  const writers = {
    'codex-toml': () => previewCodexConfiguration(pack, agent, context, io),
    'claude-code-settings': () => CONFIG_WRITERS['claude-code-settings'].connect(pack, agent, context, { readConfig: io.readJson, writeConfig: io.writeJson }),
    'cursor-hooks': () => CONFIG_WRITERS['cursor-hooks'].connect(pack, agent, context, { readConfig: io.readJson, writeConfig: io.writeJson })
  };
  writers[pack.configWriter]();
  return [...after].filter(([path, text]) => text !== before.get(path)).map(([path, text]) => ({ path, before: before.get(path), after: text }));
}
