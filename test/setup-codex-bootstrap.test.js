import assert from 'node:assert/strict';
import test from 'node:test';

import {
  installCodexBootstrap,
  isCodexBootstrapCurrent,
  removeFuliGlobalInstructions,
  replaceFuliGlobalInstructions
} from '../src/setup/codex-bootstrap.js';
import { builtInClientPack } from '../test-support/client-packs.js';

const INSTRUCTIONS = builtInClientPack('codex').instructions.global;

const AGENT = Object.freeze({
  globalInstructionsPath: '/codex/AGENTS.md',
  globalInstructionsOverridePath: '/codex/AGENTS.override.md'
});

test('Codex global instructions preserve unrelated guidance and keep a short bootstrap', () => {
  const source = '# Existing guidance\n\nKeep this.\n';
  const first = replaceFuliGlobalInstructions(source, INSTRUCTIONS);
  const second = replaceFuliGlobalInstructions(first, INSTRUCTIONS);
  const managed = first.slice(first.indexOf('<!-- BEGIN FULI'));

  assert.equal(second, first);
  assert.match(first, /# Existing guidance/);
  assert.match(managed, /start of every user task/i);
  assert.match(managed, /use the FULI hook context if supplied/i);
  assert.match(managed, /do not repeat the fallback/i);
  assert.match(managed, /otherwise before any other tool or answer/i);
  assert.match(managed, /before any other tool or answer/i);
  assert.match(managed, /get_collaboration_preferences/);
  assert.match(managed, /call exactly.*get_collaboration_preferences/is);
  assert.match(managed, /never substitute.*(?:project action|Fuli tool)/is);
  assert.match(managed, /projectPath.*current working directory/s);
  assert.match(managed, /taskPrompt.*current user request/s);
  assert.match(managed, /never stores or returns them/i);
  assert.match(managed, /task_knowledge_recall/);
  assert.match(managed, /stable project fact or method/i);
  assert.match(managed, /search_current_project_knowledge/);
  assert.match(managed, /focused.*action\/artifact\/target\/identifier/is);
  assert.match(managed, /never use the full request as the only query/i);
  assert.match(managed, /all returned `effective_preferences`/);
  assert.match(managed, /write tools?.*actual payload/is);
  assert.match(managed, /mentioning.*later.*not compliance/is);
  // Unlisted chat-profile tools are not named, so Codex does not run discovery first.
  assert.doesNotMatch(managed, /begin_task_context|coordinate_project_agent_task|runtime_lease|resolve_deferred/);
  assert.match(managed, /only when the task needs it.*list_agent_interfaces/is);
  assert.ok(Buffer.byteLength(managed, 'utf8') < 1000);
  assert.equal(removeFuliGlobalInstructions(first), source);
});

test('Codex bootstrap writes the active override and becomes current', () => {
  const texts = new Map([
    [AGENT.globalInstructionsPath, '# Base\n'],
    [AGENT.globalInstructionsOverridePath, '# Active override\n']
  ]);
  const io = {
    fileExists: (path) => texts.has(path),
    readText: (path) => texts.get(path) ?? '',
    writeText: (path, value) => texts.set(path, value)
  };

  const installed = installCodexBootstrap(AGENT, INSTRUCTIONS, io);
  assert.equal(installed.changed, true);
  assert.equal(texts.get(AGENT.globalInstructionsPath), '# Base\n');
  assert.match(
    texts.get(AGENT.globalInstructionsOverridePath),
    /get_collaboration_preferences/
  );
  assert.equal(isCodexBootstrapCurrent(AGENT, INSTRUCTIONS, io), true);
});
