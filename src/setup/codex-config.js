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

export function connectCodex(agent, context, {
  readConfig = readText,
  writeConfig = writeTextAtomic,
  installBootstrap = installCodexBootstrap
} = {}) {
  const current = readConfig(agent.configPath);
  const next = replaceFuliTable(current, {
    command: context.nodePath,
    args: [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath]
  });
  const bootstrap = installBootstrap(agent, context);
  const registrationChanged = next !== current;
  if (registrationChanged) writeConfig(agent.configPath, next);
  return {
    id: agent.id,
    label: agent.label,
    status: 'connected',
    newTaskRequired: registrationChanged || bootstrap.changed === true
  };
}

export function disconnectCodex(agent, {
  fileExists = existsSync,
  readConfig = readText,
  writeConfig = writeTextAtomic,
  removeBootstrap = removeCodexBootstrap
} = {}) {
  const bootstrap = removeBootstrap(agent);
  let registrationChanged = false;
  if (fileExists(agent.configPath)) {
    const current = readConfig(agent.configPath);
    const next = removeFuliTables(current);
    if (next !== current) {
      writeConfig(agent.configPath, next);
      registrationChanged = true;
    }
  }
  return {
    id: agent.id,
    label: agent.label,
    status: registrationChanged || bootstrap.changed ? 'disconnected' : 'not_connected'
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
    const header = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line)?.[1]?.trim();
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
