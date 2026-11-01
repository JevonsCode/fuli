import { existsSync, readFileSync } from 'node:fs';

import { writeTextFileAtomic } from '../storage/json-file.js';

const BLOCK_START = '<!-- BEGIN FULI MANAGED INSTRUCTIONS -->';
const BLOCK_END = '<!-- END FULI MANAGED INSTRUCTIONS -->';

// The managed block's lines come from the Codex descriptor pack
// (`instructions.global`). Only tools the default chat profile lists are named
// there; naming others sent Codex to tool discovery before every task (T-P00).
// The full profile's own server instructions cover team and worker tools.
function managedBlock(lines) {
  return [BLOCK_START, ...lines, BLOCK_END].join('\n');
}

export function installCodexBootstrap(agent, instructions, {
  fileExists = existsSync,
  readText = defaultReadText,
  writeText = writeTextFileAtomic
} = {}) {
  if (!agent?.globalInstructionsPath) return { changed: false };
  const instructionsPath = activeGlobalInstructionsPath(agent, {
    fileExists,
    readText
  });
  const current = readText(instructionsPath);
  const next = replaceFuliGlobalInstructions(current, instructions);
  if (next === current) return { changed: false };
  writeText(instructionsPath, next);
  return { changed: true };
}

export function removeCodexBootstrap(agent, {
  fileExists = existsSync,
  readText = defaultReadText,
  writeText = writeTextFileAtomic
} = {}) {
  let changed = false;
  for (const filePath of [
    agent.globalInstructionsPath,
    agent.globalInstructionsOverridePath
  ].filter(Boolean)) {
    if (!fileExists(filePath)) continue;
    const current = readText(filePath);
    const next = removeFuliGlobalInstructions(current);
    if (next === current) continue;
    writeText(filePath, next);
    changed = true;
  }
  return { changed };
}

export function replaceFuliGlobalInstructions(source, instructions) {
  const withoutBlock = removeFuliGlobalInstructions(source).trimEnd();
  return `${withoutBlock ? `${withoutBlock}\n\n` : ''}${managedBlock(instructions)}\n`;
}

export function removeFuliGlobalInstructions(source) {
  const start = source.indexOf(BLOCK_START);
  if (start === -1) return source;
  const end = source.indexOf(BLOCK_END, start);
  if (end === -1) return source;
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end + BLOCK_END.length).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  if (before) return `${before}\n`;
  return after;
}

function activeGlobalInstructionsPath(agent, { fileExists, readText }) {
  const override = agent.globalInstructionsOverridePath;
  if (override && fileExists(override) && readText(override).trim()) return override;
  return agent.globalInstructionsPath;
}

function defaultReadText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}
