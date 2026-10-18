import { existsSync, readFileSync } from 'node:fs';

import { codexReviewCommandBridge } from './review-skill-adapters.js';
import { writeTextFileAtomic } from '../storage/json-file.js';

const BLOCK_START = '<!-- BEGIN FULI MANAGED INSTRUCTIONS -->';
const BLOCK_END = '<!-- END FULI MANAGED INSTRUCTIONS -->';

// Only tools the default chat profile lists are named here; naming others sent
// Codex to tool discovery before every task (T-P00). The full profile's own
// server instructions cover team and worker tools.
const GLOBAL_INSTRUCTIONS = `${BLOCK_START}
At start of every user task, use the FULI hook context if supplied;
do not repeat the fallback. Otherwise before any other tool or answer, call exactly
\`get_collaboration_preferences\` with \`projectPath\`=current working directory,
\`taskPrompt\`=current user request. Never substitute a project action.
Fuli never stores or returns them. Apply all returned \`effective_preferences\`.
Before reasking a stable project fact or method, inspect \`task_knowledge_recall\`.
On miss: \`search_current_project_knowledge\`; focused action/artifact/target/identifier;
never use the full request as the only query.
Write tools: preferences in actual payload; mentioning later is not compliance.
Other FULI work (teams, workers, saved decisions, a relevant \`deferred_conflict\`)
only when the task needs it: find the tool with \`list_agent_interfaces\`.
${codexReviewCommandBridge()}
${BLOCK_END}`;

export function installCodexBootstrap(agent, _context, {
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
  const next = replaceFuliGlobalInstructions(current);
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
