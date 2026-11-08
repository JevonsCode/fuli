import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeTextFileAtomic } from '../storage/json-file.js';

// A one-time upgrade step before agent-installer connects Claude Code or
// Codex (rec#11 #11). FULI before its lifecycle command hooks registered
// `mcp_tool` hooks that call FULI's `begin_task_context` and
// `verify_task_checkpoint` over MCP. agent-installer recognizes FULI's hooks
// by their command text only (0.4.1 has no marker for an `mcp_tool` handler),
// so it would leave these beside the new ones. This removes exactly those
// handlers, after copying the file into the backups directory, and touches
// nothing when none is there. FULI wrote them up to 0.22.1. It goes once
// agent-installer can retire them from the manifest
// (JevonsCode/agent-installer#7) and the pin moves to that release.
const LEGACY_TOOLS = new Set(['begin_task_context', 'verify_task_checkpoint']);
const isLegacyHandler = (hook) => hook?.type === 'mcp_tool' && hook.server === 'fuli' && LEGACY_TOOLS.has(hook.tool);

// Answers the files it changed. ids: FULI client IDs about to be connected.
export function retireLegacyHooks(ids, { env = process.env, homeDir, backupsDir, now = () => new Date() }) {
  const stamp = now().toISOString().replaceAll(/[:.]/g, '-');
  const files = [];
  const retire = (clientId, path, without) => {
    const text = readExisting(path);
    const next = text === null ? null : without(text);
    if (next === null || next === text) return;
    const backup = join(backupsDir, clientId, 'legacy-hooks', `${basename(path)}-${stamp}`);
    mkdirSync(join(backupsDir, clientId, 'legacy-hooks'), { recursive: true });
    copyFileSync(path, backup);
    writeTextFileAtomic(path, next);
    files.push(path);
  };
  if (ids.includes('claude-code')) retire('claude-code', join(homeDir, '.claude', 'settings.json'), withoutLegacyJsonHooks);
  if (ids.includes('codex')) {
    const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(homeDir, '.codex');
    retire('codex', join(codexHome, 'hooks.json'), withoutLegacyJsonHooks);
    retire('codex', join(codexHome, 'config.toml'), withoutLegacyTomlHooks);
  }
  return files;
}

function readExisting(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// Claude Code's settings.json and Codex's hooks.json: { hooks: { Event: [{ hooks: [handler] }] } }.
// A file that is not that shape is left for agent-installer to report.
function withoutLegacyJsonHooks(text) {
  let config;
  try { config = JSON.parse(text); } catch { return text; }
  const hooks = config?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return text;
  let removed = false;
  const kept = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { kept[event] = groups; continue; }
    const remaining = groups.map((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isLegacyHandler)) return group;
      removed = true;
      return { ...group, hooks: group.hooks.filter((hook) => !isLegacyHandler(hook)) };
    }).filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (remaining.length) kept[event] = remaining;
  }
  if (!removed) return text;
  const { hooks: _hooks, ...rest } = config;
  return `${JSON.stringify(Object.keys(kept).length ? { ...rest, hooks: kept } : rest, null, 2)}\n`;
}

// Codex's config.toml: `[[hooks.Event]]` groups of `[[hooks.Event.hooks]]`
// handlers, each with an optional `[hooks.Event.hooks.input]` table.
const TOML_HOOK_GROUP = /^\s*\[\[hooks\.([A-Za-z][A-Za-z0-9_]*)]]\s*(?:#.*)?$/;
const TOML_TABLE = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*(?:#.*)?$/;

function withoutLegacyTomlHooks(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const kept = [];
  let removed = false;
  for (let index = 0; index < lines.length;) {
    const event = TOML_HOOK_GROUP.exec(lines[index])?.[1];
    if (!event) { kept.push(lines[index]); index += 1; continue; }
    let end = index + 1;
    while (end < lines.length) {
      const table = TOML_TABLE.exec(lines[end])?.[1]?.trim();
      if (table && table !== `hooks.${event}.hooks` && table !== `hooks.${event}.hooks.input`) break;
      end += 1;
    }
    const group = withoutLegacyTomlHandlers(lines.slice(index, end), event);
    removed ||= group.removed;
    kept.push(...group.lines);
    index = end;
  }
  if (!removed) return text;
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

function withoutLegacyTomlHandlers(group, event) {
  const starts = group.flatMap((line, index) =>
    index > 0 && /^\s*\[\[/.test(line) && TOML_TABLE.exec(line)?.[1]?.trim() === `hooks.${event}.hooks` ? [index] : []);
  const handlers = starts.map((start, index) => group.slice(start, starts[index + 1] ?? group.length));
  const kept = handlers.filter((handler) => !isLegacyTomlHandler(handler.join('\n')));
  if (kept.length === handlers.length) return { lines: group, removed: false };
  return { lines: kept.length ? [...group.slice(0, starts[0]), ...kept.flat()] : [], removed: true };
}

function isLegacyTomlHandler(source) {
  const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm').exec(source)?.[1];
  return isLegacyHandler({ type: value('type'), server: value('server'), tool: value('tool') });
}
