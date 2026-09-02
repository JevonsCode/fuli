import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

export function connectCodex(agent, context, {
  readConfig = readText,
  writeConfig = writeTextAtomic,
  readHooks = readJsonFile,
  writeHooks = writeJsonFileAtomic,
  installBootstrap = installCodexBootstrap,
  installHooks = installCodexLifecycleHooks
} = {}) {
  const current = readConfig(agent.configPath);
  let next = replaceFuliTable(current, {
    command: context.nodePath,
    args: [
      context.mcpServerPath,
      '--runtime-config',
      context.runtimeConfigPath,
      '--source-application',
      'codex'
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
  writeConfig = writeTextAtomic,
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

function writeTextAtomic(filePath, value) {
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(tempPath, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}
