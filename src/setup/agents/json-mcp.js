import { existsSync, readFileSync } from 'node:fs';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { writeTextFileAtomic } from '../../storage/json-file.js';
import { assertJsonObject } from '../../validation/values.js';
import { installedToolProfile } from '../installed-tool-profile.js';

export function parseMcpJson(text, { jsonc = false } = {}) {
  if (!jsonc) return JSON.parse(text);
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || value === undefined) throw new TypeError('Invalid client configuration');
  return value;
}

// Null when the client has no configuration file yet.
function readConfigText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// The client owns its schema. This shared port only changes the FULI entry.
// `entryArgs` renders a descriptor pack's arguments in place of the fixed ones.
export function jsonMcpPort({ key = 'mcpServers', jsonc = false, source = 'other', server, argsOf, obsoleteKeys = [],
  entryArgs }) {
  function read(agent, readText = readConfigText) {
    const text = readText(agent.configPath) ?? '{}';
    return { text, config: validate(parseMcpJson(text, { jsonc })) };
  }
  function validate(config) {
    assertJsonObject(config, 'Client configuration');
    if (config[key] !== undefined) assertJsonObject(config[key], 'MCP servers');
    if (config[key]?.fuli !== undefined) assertJsonObject(config[key].fuli, 'FULI server');
    return config;
  }
  function expected(context, current) {
    const profile = installedToolProfile(argsOf(current), context.toolProfile);
    const args = entryArgs ? entryArgs(context, profile) : [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath,
      '--source-application', source, '--tool-profile', profile];
    const retained = Object.fromEntries(Object.entries(current ?? {}).filter(([key]) => !obsoleteKeys.includes(key)));
    return { ...retained, ...server(context.nodePath, args) };
  }
  function write(agent, text, value, writeText = writeTextFileAtomic) {
    writeText(agent.configPath, applyEdits(text, modify(text, [key, 'fuli'], value,
      { formattingOptions: { insertSpaces: true, tabSize: 2 } })));
  }
  return {
    // `readText` (null for an absent file) and `writeText` let a preview capture the write.
    connect(agent, context, { readText, writeText } = {}) {
      if (agent.manualOnly) throw new TypeError('This client configuration requires manual connection');
      const { text, config } = read(agent, readText);
      const current = config[key]?.fuli;
      const next = expected(context, current);
      const changed = JSON.stringify(current) !== JSON.stringify(next);
      if (changed) write(agent, text, next, writeText);
      return { id: agent.id, label: agent.label, status: 'connected', restartRequired: changed };
    },
    disconnect(agent) {
      if (agent.manualOnly) throw new TypeError('This client configuration requires manual connection');
      const { text, config } = read(agent);
      const present = Object.hasOwn(config[key] ?? {}, 'fuli');
      if (present) write(agent, text, undefined);
      return { id: agent.id, label: agent.label, status: present ? 'disconnected' : 'not_connected' };
    },
    status(agent, context, readers) {
      let present = false;
      try {
        const config = validate(readers ? readers.readJson(agent.configPath, { jsonc }) : read(agent).config);
        const current = config[key]?.fuli;
        present = Boolean(current);
        return { registration: { present, current: present &&
          JSON.stringify(current) === JSON.stringify(expected(context, current)) } };
      } catch { return { registration: { present, current: false } }; }
    }
  };
}
