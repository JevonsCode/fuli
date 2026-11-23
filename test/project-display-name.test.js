import test from 'node:test';
import assert from 'node:assert/strict';

import { consoleLanguage } from '../src/app/console-language.js';
import { agentDisplayName, isGeneratedAgentName, shownAgentName } from '../src/graphiti/agent-display-name.js';
import {
  applicationLanguage, givenProjectTitle, isTemporaryProject, projectDisplayName, temporaryProjectNumber
} from '../src/graphiti/project-display-name.js';

// Synthetic records only: a digest of one repeated character, synthetic names.
const temporaryId = character => `temporary-${character.repeat(64)}`;
const conversationId = character => `conversation-${character.repeat(64)}`;
const project = (project_id, name, extra = {}) => ({ project_id, profile: { name }, ...extra });

test('a temporary project is known by where it came from, never by its name', () => {
  assert.equal(isTemporaryProject(project(temporaryId('a'), '')), true);
  assert.equal(isTemporaryProject(project(conversationId('b'), '会话项目 / Conversation project')), true);
  assert.equal(isTemporaryProject(project('synthetic-x', '', { scope_type: 'temporary' })), true);
  assert.equal(isTemporaryProject(project('synthetic-y', '', { profile: { origin: 'conversation_fallback' } })), true);
  assert.equal(isTemporaryProject(project('synthetic-z', '临时会话 / Temporary session')), false,
    'a generated-looking name on a registered ID does not make it temporary');
});

test('an unnamed temporary project is named in the language the person reads FULI in', () => {
  const unnamed = project(temporaryId('a'), '', { updated_at: '2026-10-17T07:20:00Z' });
  assert.match(projectDisplayName(unnamed, 'zh-CN'), /^临时项目 #aaaaaaaa · /);
  assert.match(projectDisplayName(unnamed, 'en-US'), /^Temporary project #aaaaaaaa · /);
  assert.equal(projectDisplayName(project(temporaryId('b'), ''), 'en-US'), 'Temporary project #bbbbbbbb');
  assert.equal(projectDisplayName(project(temporaryId('c'), ''), 'fr-FR'), '临时项目 #cccccccc', 'unknown language: the default');
});

test('a name FULI generated before graph/23 is never shown as a title', () => {
  for (const name of ['会话项目 / Conversation project', '临时任务 / Temporary task', '临时会话 / Temporary session']) {
    assert.equal(givenProjectTitle(project(conversationId('d'), name)), '');
    assert.equal(projectDisplayName(project(conversationId('d'), name), 'en-US'), 'Temporary project #dddddddd');
  }
});

test('a name someone gave stays, temporary or not', () => {
  assert.equal(projectDisplayName(project(temporaryId('e'), 'Synthetic garden notes'), 'en-US'), 'Synthetic garden notes');
  assert.equal(projectDisplayName(project('synthetic-formal', 'Synthetic formal'), 'en-US'), 'Synthetic formal');
  assert.equal(projectDisplayName(project('synthetic-unnamed', ''), 'en-US'), 'synthetic-unnamed',
    'a registered project with no name falls back to its ID, never a blank line');
});

test('the number is the one the console shows for the same project', () => {
  assert.equal(temporaryProjectNumber(temporaryId('f')), 'ffffffff');
  assert.equal(temporaryProjectNumber('synthetic-formal'), null);
});

test('the language is the console setting, else this computer, else the default', () => {
  assert.equal(consoleLanguage('en-US', 'zh-Hans-CN'), 'en-US');
  assert.equal(consoleLanguage('', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(consoleLanguage('', 'de-DE'), 'en-US');
  assert.equal(applicationLanguage({ flaMenuSettings: () => ({ language: 'en-US' }) }), 'en-US');
  assert.equal(applicationLanguage({ flaMenuSettings: () => { throw new Error('unreadable'); } }),
    consoleLanguage(''), 'unreadable settings fall back to this computer');
});

test('a lead or specialist FULI named by itself is shown in the person\'s words', () => {
  assert.equal(shownAgentName('会话项目 / Conversation project 负责人', 'zh-CN'), '临时项目的助手');
  assert.equal(shownAgentName('会话项目 / Conversation project 负责人', 'en-US'), 'Temporary project assistant');
  assert.equal(shownAgentName('#ab12ab12 负责人', 'zh-CN'), '临时项目 #ab12ab12 的助手');
  assert.equal(shownAgentName('code_review Agent', 'en-US'), 'Specialist assistant');
  assert.equal(shownAgentName('implementation_and_verification Agent', 'zh-CN', { occupationName: '开发' }), '开发助手');
  for (const kept of ['Synthetic garden 负责人', 'Nova', 'Code Review Agent', 'Synthetic Agent']) {
    assert.equal(isGeneratedAgentName(kept), false, kept);
    assert.equal(shownAgentName(kept, 'en-US'), kept);
  }
});

test('an FLA\'s given name wins over its role name; a generated given name does not', () => {
  assert.equal(agentDisplayName({ agentId: 'a', profile: { displayName: 'Nova', name: 'code_review Agent' } }, 'en-US'), 'Nova');
  assert.equal(agentDisplayName({ agent_id: 'b', profile: { display_name: 'code_review Agent', name: 'code_review Agent' } }, 'en-US'),
    'Specialist assistant');
  assert.equal(agentDisplayName({ agentId: 'c', profile: {} }, 'en-US'), 'c');
});
