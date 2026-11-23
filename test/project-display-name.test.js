import test from 'node:test';
import assert from 'node:assert/strict';

import { consoleLanguage } from '../src/app/console-language.js';
import { agentDisplayName } from '../src/graphiti/agent-display-name.js';
import { applicationLanguage, isTemporaryProject, projectDisplayName } from '../src/graphiti/project-display-name.js';

// Synthetic records only: a digest of one repeated character, synthetic names.
const temporaryId = character => `temporary-${character.repeat(64)}`;
const conversationId = character => `conversation-${character.repeat(64)}`;
const project = (project_id, name, extra = {}) => ({ project_id, profile: { name }, ...extra });
const agent = (name, extra = {}) => ({ agentId: 'synthetic-agent', profile: { name, ...extra } });

test('a temporary project is known by its scope_type first, never by its name or a readable ID', () => {
  assert.equal(isTemporaryProject(project('synthetic-x', 'Anything', { scope_type: 'temporary' })), true);
  assert.equal(isTemporaryProject(project(temporaryId('a'), '')), true, 'a generated ID with no name of its own');
  assert.equal(isTemporaryProject(project(conversationId('b'), '会话项目 / Conversation project', { scope_type: 'registered' })), true,
    'a conversation fallback a graph waiting for graph/23 has not marked yet');
  // A conversation project a person named is theirs: a roundtable target, a board of its own.
  assert.equal(isTemporaryProject(project(conversationId('c'), 'Synthetic garden notes', { scope_type: 'registered' })), false);
  // IDs a person's project names make ('Temporary fix', 'Conversation notes').
  assert.equal(isTemporaryProject(project('temporary-fix', 'Temporary fix', { scope_type: 'registered' })), false);
  assert.equal(isTemporaryProject(project('conversation-notes', 'Conversation notes')), false);
});

test('the profile name decides when it and the name column disagree, as in the Provider and the console', () => {
  // The Provider's `mismatched` seed (test_graph_format_confirm_neo4j.py): FULI's name in the column, a person's in the profile.
  const mismatched = { project_id: conversationId('9'), name: '会话项目 / Conversation project', profile: { name: 'Synthetic own words' } };
  assert.equal(isTemporaryProject(mismatched), false);
  assert.equal(projectDisplayName(mismatched, 'en-US'), 'Synthetic own words');
});

test('an unnamed temporary project is named by its number, in the person\'s language, with no date', () => {
  const used = project(temporaryId('a'), '', { scope_type: 'temporary', updated_at: '2026-10-17T07:20:00Z' });
  assert.equal(projectDisplayName(used, 'zh-CN'), '临时项目 #aaaaaaaa');
  assert.equal(projectDisplayName(used, 'en-US'), 'Temporary project #aaaaaaaa');
  // The same however often the project is used: menus, resource titles and prompt files stay put.
  assert.equal(projectDisplayName({ ...used, updated_at: '2026-11-23T00:00:00Z' }, 'en-US'), 'Temporary project #aaaaaaaa');
  assert.equal(projectDisplayName(project(temporaryId('c'), ''), 'fr-FR'), '临时项目 #cccccccc', 'unknown language: the default');
});

test('a name FULI generated before graph/23 is never shown as a title', () => {
  for (const name of ['会话项目 / Conversation project', '临时任务 / Temporary task', '临时会话 / Temporary session']) {
    assert.equal(projectDisplayName(project(conversationId('d'), name), 'en-US'), 'Temporary project #dddddddd');
  }
});

test('a readable-ID project whose name happens to be a generated one shows that name, as the Provider and the console do', () => {
  // A person's project before graph/23 marks nothing: it is not temporary, so its stored name stands.
  const readable = project('synthetic-notes', '临时任务 / Temporary task', { scope_type: 'registered' });
  assert.equal(isTemporaryProject(readable), false);
  assert.equal(projectDisplayName(readable, 'en-US'), '临时任务 / Temporary task');
});

test('a name someone gave stays, temporary or not, and a nameless registered project shows its ID', () => {
  assert.equal(projectDisplayName(project(temporaryId('e'), 'Synthetic garden notes'), 'en-US'), 'Synthetic garden notes');
  assert.equal(projectDisplayName(project('synthetic-formal', 'Synthetic formal'), 'en-US'), 'Synthetic formal');
  assert.equal(projectDisplayName(project('synthetic-unnamed', ''), 'en-US'), 'synthetic-unnamed');
});

test('the language is the console setting, else this computer, else the default', () => {
  assert.equal(consoleLanguage('en-US', 'zh-Hans-CN'), 'en-US');
  assert.equal(consoleLanguage('', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(consoleLanguage('', 'de-DE'), 'en-US');
  assert.equal(applicationLanguage({ flaMenuSettings: () => ({ language: 'en-US' }) }), 'en-US');
  assert.equal(applicationLanguage({ flaMenuSettings: () => { throw new Error('unreadable'); } }), consoleLanguage(''));
});

test('a lead or specialist FULI named by itself is shown in the person\'s words', () => {
  assert.equal(agentDisplayName(agent('会话项目 / Conversation project 负责人'), 'zh-CN'), '临时项目的助手');
  assert.equal(agentDisplayName(agent('会话项目 / Conversation project 负责人'), 'en-US'), 'Temporary project assistant');
  assert.equal(agentDisplayName(agent('#ab12ab12 负责人'), 'zh-CN'), '临时项目 #ab12ab12 的助手');
  assert.equal(agentDisplayName(agent('code_review Agent'), 'en-US'), 'Specialist assistant');
  assert.equal(agentDisplayName(agent('implementation_and_verification Agent'), 'zh-CN', { occupationName: '开发' }), '开发助手');
  for (const kept of ['Synthetic garden 负责人', 'Nova', 'Code Review Agent', 'Synthetic Agent']) {
    assert.equal(agentDisplayName(agent(kept), 'en-US'), kept);
  }
});

test('an FLA\'s given name wins over its role name; a generated given name does not', () => {
  assert.equal(agentDisplayName(agent('code_review Agent', { displayName: 'Nova' }), 'en-US'), 'Nova');
  assert.equal(agentDisplayName({ agent_id: 'b', profile: { display_name: 'code_review Agent', name: 'code_review Agent' } }, 'en-US'),
    'Specialist assistant');
  assert.equal(agentDisplayName({ agentId: 'c', profile: {} }, 'en-US'), 'c');
});
