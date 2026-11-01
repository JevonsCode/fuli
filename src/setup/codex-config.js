import { existsSync, readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';

import {
  installCodexBootstrap,
  removeCodexBootstrap
} from './codex-bootstrap.js';
import {
  hasCodexTomlHookDefinitions,
  hasCurrentCodexTomlLifecycleHooks,
  installCodexLifecycleHooks,
  removeCodexLifecycleHooks,
  withCodexTomlLifecycleHooks,
  withoutCodexLifecycleHooks,
  withoutCodexTomlLifecycleHooks
} from '../agents/codex/lifecycle-hooks.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { installedToolProfile } from './installed-tool-profile.js';
import { writeTextFileAtomic } from '../storage/json-file.js';
import { renderMcpEntry } from './agents/mcp-entry-template.js';

// The 'codex-toml' config writer: the MCP table in config.toml, lifecycle hooks
// in hooks.json (or in config.toml when the person keeps hooks there) and the
// managed global instructions block.
export function connectCodex(pack, agent, context, {
  readConfig = readText,
  writeConfig = writeTextFileAtomic,
  readHooks = readJsonFile,
  writeHooks = writeJsonFileAtomic,
  installBootstrap = installCodexBootstrap,
  installHooks = installCodexLifecycleHooks
} = {}) {
  const current = readConfig(agent.configPath);
  let next = replaceFuliTable(current, fuliTable(pack, context, current));
  const hooksSpec = pack.lifecycleHooks;
  const tomlHooksPresent = Boolean(
    agent.hooksPath && hasCodexTomlHookDefinitions(current)
  );
  const currentHooks = agent.hooksPath ? readHooks(agent.hooksPath, {}) : null;
  const remainingHooks = currentHooks === null
    ? null
    : withoutCodexLifecycleHooks(currentHooks);
  if (tomlHooksPresent && hasHookDefinitions(remainingHooks)) {
    throw new Error(
      'Codex has unrelated hooks in both config.toml and hooks.json; ' +
      'Fuli cannot safely choose one representation automatically.'
    );
  }

  const bootstrap = installBootstrap(agent, pack.instructions.global);
  let hooks;
  let hooksJsonWrite = null;
  if (tomlHooksPresent) {
    const withHooks = withCodexTomlLifecycleHooks(next, { context, hooks: hooksSpec });
    const jsonChanged = JSON.stringify(currentHooks) !== JSON.stringify(remainingHooks);
    const tomlHooksChanged = !hasCurrentCodexTomlLifecycleHooks(current, {
      context, hooks: hooksSpec
    });
    hooks = {
      changed: tomlHooksChanged || jsonChanged,
      trustReviewRequired: tomlHooksChanged || jsonChanged
    };
    next = withHooks;
    if (jsonChanged) hooksJsonWrite = remainingHooks;
  } else {
    hooks = installHooks(agent, { context, hooks: hooksSpec });
  }
  const registrationChanged = next !== current;
  if (registrationChanged) writeConfig(agent.configPath, next);
  if (hooksJsonWrite !== null) writeHooks(agent.hooksPath, hooksJsonWrite);
  return {
    id: agent.id,
    label: agent.label,
    status: 'connected',
    newTaskRequired: registrationChanged || bootstrap.changed === true || hooks.changed === true,
    ...(hooks.trustReviewRequired === true ? { trustReviewRequired: true } : {}),
    ...(agent.hooksPath ? {
      nextSteps: [hooks.trustReviewRequired === true
        ? 'Review and trust Fuli hooks in the Codex CLI with /hooks ' +
          'before relying on automatic task entry.'
        : 'Check Fuli hooks in the Codex CLI with /hooks; setup does not verify hook trust.']
    } : {})
  };
}

// The one profile rule connect and status share, as for Claude Code and Cursor:
// a requested profile wins, else an explicit profile already in the config is
// kept, else chat (Codex sends every listed tool schema with each request).
function fuliTable(pack, context, current) {
  const profile = installedToolProfile(existingFuliArgs(current), context.toolProfile);
  return renderMcpEntry(pack.mcpServer, { nodePath: context.nodePath, mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath, toolProfileArgs: ['--tool-profile', profile] });
}

function hasHookDefinitions(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  if (!value.hooks || Array.isArray(value.hooks) || typeof value.hooks !== 'object') return false;
  return Object.values(value.hooks).some((groups) => Array.isArray(groups) && groups.length > 0);
}

export function disconnectCodex(agent, {
  fileExists = existsSync,
  readConfig = readText,
  writeConfig = writeTextFileAtomic,
  removeBootstrap = removeCodexBootstrap,
  removeHooks = removeCodexLifecycleHooks
} = {}) {
  const bootstrap = removeBootstrap(agent);
  const hooks = removeHooks(agent);
  let registrationChanged = false;
  if (fileExists(agent.configPath)) {
    const current = readConfig(agent.configPath);
    const next = removeFuliTables(withoutCodexTomlLifecycleHooks(current));
    if (next !== current) {
      writeConfig(agent.configPath, next);
      registrationChanged = true;
    }
  }
  return {
    id: agent.id,
    label: agent.label,
    status: registrationChanged || bootstrap.changed || hooks.changed ? 'disconnected' : 'not_connected'
  };
}

// `entry` is the rendered MCP entry of the Codex descriptor pack (strings,
// string arrays, booleans and integers), written in the pack's field order.
export function replaceFuliTable(source, entry) {
  const withoutFuli = removeFuliTables(source);
  const lines = withoutFuli.replaceAll('\r\n', '\n').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const block = ['[mcp_servers.fuli]', ...Object.entries(entry).map(([key, value]) => `${key} = ${tomlValue(value)}`)];
  return `${[...lines, ...(lines.length ? [''] : []), ...block].join('\n')}\n`;
}

// The args of the existing fuli MCP entry, so an explicit choice the person
// made (such as --tool-profile full) survives a reconnect. Any valid TOML form
// is read (quoted table names, multi-line arrays, literal strings, comments).
// If the file does not parse, the fuli table is read on its own, so an
// unrelated syntax error, another server's profile or a commented-out
// profile never changes the person's choice.
export function existingFuliArgs(source) {
  try {
    return stringArgs(parseToml(source)?.mcp_servers?.fuli?.args);
  } catch {
    const body = fuliTableBody(source);
    try {
      return stringArgs(parseToml(body.join('\n'))?.args);
    } catch {
      const text = body.map(stripTomlComment).join('\n');
      const profile = /["']--tool-profile["']\s*,\s*["']([^"']+)["']/.exec(text)?.[1];
      return profile ? ['--tool-profile', profile] : [];
    }
  }
}

const stringArgs = (args) => (Array.isArray(args) ? args.filter(value => typeof value === 'string') : []);

const FULI_TABLE_HEADER = /^\s*\[\s*["']?mcp_servers["']?\s*\.\s*["']?fuli["']?\s*\]?\s*(?:#.*)?$/;

// The lines of the first fuli table, up to the next table header.
function fuliTableBody(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex(line => FULI_TABLE_HEADER.test(line));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

// Drop a TOML comment while leaving a # inside a basic or literal string alone.
function stripTomlComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === '\\') index++;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

export function removeFuliTables(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const kept = [];
  let skipping = false;
  let removed = false;

  for (const line of lines) {
    const header = tomlHeaderName(line);
    if (header) {
      skipping = isFuliTable(header);
      if (skipping) removed = true;
    }
    if (!skipping) kept.push(line);
  }

  if (!removed) return source;
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

function tomlHeaderName(line) {
  return (
    /^\s*\[\[([^\]]+)]]\s*(?:#.*)?$/.exec(line)?.[1] ??
    /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line)?.[1]
  )?.trim();
}

function isFuliTable(header) {
  return /^mcp_servers\.(?:fuli|"fuli"|'fuli')(?:\.|$)/.test(header);
}

function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlString).join(', ')}]`;
  return typeof value === 'string' ? tomlString(value) : String(value);
}

function tomlString(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Codex MCP values must be nonempty');
  return JSON.stringify(value);
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}
