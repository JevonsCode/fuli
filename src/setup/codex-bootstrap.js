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

import { codexReviewCommandBridge } from './review-skill-adapters.js';

const BLOCK_START = '<!-- BEGIN FULI MANAGED INSTRUCTIONS -->';
const BLOCK_END = '<!-- END FULI MANAGED INSTRUCTIONS -->';

const GLOBAL_INSTRUCTIONS = `${BLOCK_START}
At the start of every user task, before any other tool or answer, call exactly
\`get_collaboration_preferences\` with \`projectPath\`=current working directory and
\`taskPrompt\`=current user request; never substitute a project action/Fuli tool. Fuli uses both
transiently and never stores or returns them. Apply all returned \`effective_preferences\`.
Before asking the user to repeat a stable project fact or method, inspect
\`task_knowledge_recall\`. On miss call \`search_current_project_knowledge\` with 1-4 focused
action/artifact/target/identifier queries; never use the full request as the only query.
For write tools enforce them in the actual payload; mentioning them later is not compliance.
Relevant \`deferred_conflict\`: call \`resolve_deferred_preference_conflict\` first; ignore others.
Current request wins.
${codexReviewCommandBridge()}
${BLOCK_END}`;

export function installCodexBootstrap(agent, _context, {
  fileExists = existsSync,
  readText = defaultReadText,
  writeText = writeTextAtomic
} = {}) {
  if (!agent?.globalInstructionsPath) return { changed: false };
  const instructionsPath = activeGlobalInstructionsPath(agent, {
    fileExists,
    readText
  });
  const current = readText(instructionsPath);
  const next = replaceFuliGlobalInstructions(current);
  if (next === current) return { changed: false };
  writeText(instructionsPath, next);
  return { changed: true };
}

export function removeCodexBootstrap(agent, {
  fileExists = existsSync,
  readText = defaultReadText,
  writeText = writeTextAtomic
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

export function isCodexBootstrapCurrent(agent, _context, {
  fileExists = existsSync,
  readText = defaultReadText
} = {}) {
  if (!agent?.globalInstructionsPath) return false;
  try {
    const instructionsPath = activeGlobalInstructionsPath(agent, {
      fileExists,
      readText
    });
    const current = readText(instructionsPath);
    return replaceFuliGlobalInstructions(current) === current;
  } catch {
    return false;
  }
}

export function replaceFuliGlobalInstructions(source) {
  const withoutBlock = removeFuliGlobalInstructions(source).trimEnd();
  return `${withoutBlock ? `${withoutBlock}\n\n` : ''}${GLOBAL_INSTRUCTIONS}\n`;
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

function writeTextAtomic(filePath, value) {
  const directory = dirname(filePath);
  const temporary = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
