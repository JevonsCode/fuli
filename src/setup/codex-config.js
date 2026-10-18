import { existsSync, readFileSync } from 'node:fs';

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

export function connectCodex(agent, context, {
  readConfig = readText,
  writeConfig = writeTextFileAtomic,
  readHooks = readJsonFile,
  writeHooks = writeJsonFileAtomic,
  installBootstrap = installCodexBootstrap,
  installHooks = installCodexLifecycleHooks
} = {}) {
  const current = readConfig(agent.configPath);
  // Codex sends every listed tool schema with each request, so it gets the
  // chat profile; an explicit profile already in the config is kept.
  let next = replaceFuliTable(current, {
    command: context.nodePath,
    args: [
      context.mcpServerPath,
      '--runtime-config',
      context.runtimeConfigPath,
      '--source-application',
      'codex',
      '--tool-profile',
      installedToolProfile(existingFuliArgs(current))
    ]
  });
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

  const bootstrap = installBootstrap(agent, context);
  let hooks;
  let hooksJsonWrite = null;
  if (tomlHooksPresent) {
    const withHooks = withCodexTomlLifecycleHooks(next, { context });
    const jsonChanged = JSON.stringify(currentHooks) !== JSON.stringify(remainingHooks);
    const tomlHooksChanged = !hasCurrentCodexTomlLifecycleHooks(current, {
      context
    });
    hooks = {
      changed: tomlHooksChanged || jsonChanged,
      trustReviewRequired: tomlHooksChanged || jsonChanged
    };
    next = withHooks;
    if (jsonChanged) hooksJsonWrite = remainingHooks;
  } else {
    hooks = installHooks(agent, { context });
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

export function replaceFuliTable(source, { command, args }) {
  const withoutFuli = removeFuliTables(source);
  const lines = withoutFuli.replaceAll('\r\n', '\n').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const block = [
    '[mcp_servers.fuli]',
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    'enabled = true',
    'required = true',
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    'default_tools_approval_mode = "auto"'
  ];
  return `${[...lines, ...(lines.length ? [''] : []), ...block].join('\n')}\n`;
}

// The args of an existing [mcp_servers.fuli] table, written as JSON strings.
export function existingFuliArgs(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === '[mcp_servers.fuli]');
  if (start < 0) return [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*args\s*=\s*(\[.*\])\s*$/);
    if (!match) continue;
    try { return JSON.parse(match[1]); } catch { return []; }
  }
  return [];
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

function tomlString(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Codex MCP values must be nonempty');
  return JSON.stringify(value);
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}
