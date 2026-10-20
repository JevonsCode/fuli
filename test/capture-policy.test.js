import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CapturePolicyStore,
  capturePolicyPathForRuntime
} from '../src/graphiti/capture-policy.js';
import { writeFileSync } from 'node:fs';
import { checkpointConversation } from '../src/graphiti/agent-conversations.js';
import { captureDecision } from '../src/graphiti/capture-decision.js';

// What a policy with no project setting means: every project is recorded.
const ALL_PROJECTS = { projectMode: 'all', excludedProjectIds: [], selectedProjectIds: [],
  unregisteredDirectories: 'capture', projectsOffSince: {}, unlistedProjectsOffSince: null };

test('capture policy defaults to enabled and is shared across runtime processes', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const first = new CapturePolicyStore(path, { now: () => '2026-07-22T10:00:00.000Z' });
  const second = new CapturePolicyStore(path);

  assert.deepEqual(first.read(), { enabled: true, disabledSources: [], ...ALL_PROJECTS, updatedAt: null });
  assert.deepEqual(first.update({ enabled: false }), {
    enabled: false,
    disabledSources: [],
    ...ALL_PROJECTS,
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.deepEqual(second.read(), {
    enabled: false,
    disabledSources: [],
    ...ALL_PROJECTS,
    updatedAt: '2026-07-22T10:00:00.000Z'
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
});

test('capture policy accepts only an explicit boolean', () => {
  const store = new CapturePolicyStore();
  assert.throws(() => store.update({ enabled: 'false' }), /must be a boolean/);
  assert.throws(() => store.update({ enabled: null }), /must be a boolean/);
});

test('capture policy lives beside the shared graph runtime configuration', () => {
  // An absolute host path: the policy path is resolved, so a POSIX literal is not absolute on Windows.
  const runtimeDirectory = join(tmpdir(), 'fuli-runtime');
  assert.equal(
    capturePolicyPathForRuntime(join(runtimeDirectory, 'graph-runtime.json')),
    join(runtimeDirectory, 'capture-policy.json')
  );
});

test('one client can stop being captured while every client keeps using FULI', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-sources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path, { now: () => '2026-10-18T00:00:00.000Z' });
  const app = { getCapturePolicy: () => store.read() };
  assert.deepEqual(store.update({ enabled: true, disabledSources: ['codex'] }).disabledSources, ['codex']);
  assert.deepEqual(await captureDecision(app, { sourceApplication: 'codex' }), { allowed: false, reason: 'client_off', layer: 'client' });
  assert.equal((await captureDecision(app, { sourceApplication: 'claude_code' })).allowed, true);
  assert.equal((await captureDecision(app)).allowed, true);
  // A later global toggle keeps the per-client choice unless it is sent again.
  assert.deepEqual(store.update({ enabled: false }).disabledSources, ['codex']);
  assert.equal((await captureDecision(app, { sourceApplication: 'claude_code' })).reason, 'global_off');
  assert.throws(() => store.update({ enabled: true, disabledSources: ['unknown'] }), /distinct supported clients/);
  assert.throws(() => store.update({ enabled: true, disabledSources: ['codex', 'codex'] }), /distinct supported clients/);
});

test('policies saved before per-client capture still capture every client', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-legacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, updatedAt: null }));
  assert.deepEqual(new CapturePolicyStore(path).read().disabledSources, []);
});

test('a disabled client saves no conversation while the others still do', async () => {
  const saved = [];
  const application = { config: { personal: { spaceId: 'space' } },
    getCapturePolicy: () => ({ enabled: true, disabledSources: ['codex'] }),
    personal: { conversation: async (operation, input) => { saved.push(input.source_application); return { status: 'saved', conversation_id: 'c' }; },
      getProjectAgent: async () => ({ profile: { name: 'Lead' } }) } };
  const task = { token: 't', projectAgentId: 'lead', personalProjectId: 'p', sessionId: 's' };
  const log = { status: 'completed', summary: 'done' };
  assert.deepEqual(await checkpointConversation(application, { ...task, sourceApplication: 'codex' }, log),
    { status: 'capture_disabled', reason: 'client_off', layer: 'client' });
  assert.equal((await checkpointConversation(application, { ...task, sourceApplication: 'claude_code' }, log)).status, 'saved');
  assert.deepEqual(saved, ['claude_code']);
});

// rec#5 C2: project modes live in the same settings file as the global and client switches.
test('project modes are stored beside the other switches and default to recording every project', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-project-modes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  let now = '2026-10-20T01:00:00.000Z';
  const store = new CapturePolicyStore(path, { now: () => now });
  assert.deepEqual(store.read(), { enabled: true, disabledSources: [], projectMode: 'all', excludedProjectIds: [],
    selectedProjectIds: [], unregisteredDirectories: 'capture', projectsOffSince: {}, unlistedProjectsOffSince: null,
    updatedAt: null });

  // A partial update changes only what it names; the global switch is kept.
  store.update({ enabled: false });
  const selected = store.update({ projectMode: 'selected', selectedProjectIds: ['thesis', 'thesis'] });
  assert.equal(selected.enabled, false);
  assert.deepEqual(selected.selectedProjectIds, ['thesis']);
  assert.equal(selected.unregisteredDirectories, 'skip', 'selected mode skips unregistered directories by default');
  assert.equal(selected.unlistedProjectsOffSince, now, 'every project but the selected ones stopped now');
  assert.deepEqual(new CapturePolicyStore(path).read(), selected);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 2);

  now = '2026-10-20T02:00:00.000Z';
  const back = store.update({ projectMode: 'all_except', excludedProjectIds: ['family-ledger'] });
  assert.equal(back.unregisteredDirectories, 'capture', 'a mode switch without a choice takes that mode\'s default');
  assert.deepEqual(back.selectedProjectIds, ['thesis'], 'switching modes keeps the other list for later');
  assert.deepEqual(back.projectsOffSince, { 'family-ledger': '2026-10-20T01:00:00.000Z' },
    'a project that stayed off keeps the time it was first switched off');
  assert.equal(back.unlistedProjectsOffSince, null);
  assert.equal(store.update({ unregisteredDirectories: 'skip' }).unregisteredDirectories, 'skip');
  assert.equal(store.update({ enabled: true }).unregisteredDirectories, 'skip', 'an explicit choice survives other changes');

  const all = store.update({ projectMode: 'all', unregisteredDirectories: 'capture' });
  assert.deepEqual([all.projectsOffSince, all.excludedProjectIds], [{}, ['family-ledger']]);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1,
    'default project settings keep the format older FULI versions read the same way');
});

test('a project switched off records when, and switching it back on clears it', () => {
  let now = '2026-10-20T03:00:00.000Z';
  const store = new CapturePolicyStore(null, { now: () => now });
  assert.deepEqual(store.update({ projectMode: 'all_except', excludedProjectIds: ['job-hunt'] }).projectsOffSince,
    { 'job-hunt': '2026-10-20T03:00:00.000Z' });
  now = '2026-10-21T03:00:00.000Z';
  assert.deepEqual(store.update({ excludedProjectIds: ['job-hunt', 'novel'] }).projectsOffSince,
    { 'job-hunt': '2026-10-20T03:00:00.000Z', novel: '2026-10-21T03:00:00.000Z' });
  now = '2026-10-22T03:00:00.000Z';
  assert.deepEqual(store.update({ excludedProjectIds: ['novel'] }).projectsOffSince,
    { novel: '2026-10-21T03:00:00.000Z' });
  // Leaving the selected list stops a project from the moment it left.
  store.update({ projectMode: 'selected', selectedProjectIds: ['novel', 'thesis'] });
  now = '2026-10-23T03:00:00.000Z';
  const narrowed = store.update({ selectedProjectIds: ['thesis'] });
  assert.equal(narrowed.projectsOffSince.novel, '2026-10-23T03:00:00.000Z');
  assert.equal(narrowed.unlistedProjectsOffSince, '2026-10-22T03:00:00.000Z');
});

test('project settings reject what they cannot apply and name the setting', () => {
  const store = new CapturePolicyStore();
  for (const [input, message] of [
    [{}, /name a setting/],
    [{ projectMode: 'some' }, /projectMode/],
    [{ unregisteredDirectories: 'maybe' }, /unregisteredDirectories/],
    [{ selectedProjectIds: 'thesis' }, /selectedProjectIds/],
    [{ excludedProjectIds: ['../thesis'] }, /excludedProjectIds/],
    [{ excludedProjects: ['thesis'] }, /excludedProjects/]
  ]) assert.throws(() => store.update(input), message);
  // Archived or deleted projects may stay listed: their IDs are not checked against the registry.
  assert.deepEqual(store.update({ excludedProjectIds: ['deleted-project'] }).excludedProjectIds, ['deleted-project']);
});

test('a stored project setting FULI cannot read records nothing', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-project-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path);
  const app = { getCapturePolicy: () => store.read() };
  for (const broken of [{ projectMode: 'everything' }, { selectedProjectIds: 'thesis' }, { projectsOffSince: [] },
    { unregisteredDirectories: 'sometimes' }, { version: 3 }]) {
    writeFileSync(path, JSON.stringify({ version: 2, enabled: true, disabledSources: [], updatedAt: null, ...broken }));
    assert.throws(() => store.read(), /Capture policy/, JSON.stringify(broken));
    assert.equal((await captureDecision(app, { sourceApplication: 'codex' })).reason, 'policy_unavailable');
  }
  // A partial change cannot apply to settings nobody can read; setting the
  // global switch again repairs them from the defaults.
  assert.throws(() => store.update({ projectMode: 'selected' }), /Capture policy/);
  assert.deepEqual(store.update({ enabled: false }), { enabled: false, disabledSources: [], ...ALL_PROJECTS,
    updatedAt: store.read().updatedAt });
});

test('the policy file is parsed again only when it changes, and a corrupt file is never served from cache', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  let parses = 0;
  const store = new CapturePolicyStore(path, { readText: file => { parses += 1; return readFileSync(file, 'utf8'); } });
  const writer = new CapturePolicyStore(path);
  writer.update({ enabled: true, disabledSources: [] });
  assert.equal(store.read().enabled, true);
  assert.equal(store.read().enabled, true);
  assert.equal(parses, 1, 'an unchanged file is not parsed again');
  writer.update({ enabled: false, disabledSources: ['codex'] });
  assert.deepEqual([store.read().enabled, store.read().disabledSources], [false, ['codex']]);
  assert.equal(parses, 2, 'another process changing the file is seen at once');
  writeFileSync(path, '{ not json');
  assert.throws(() => store.read(), /could not be read/);
  assert.throws(() => store.read(), /could not be read/, 'a corrupt file stays unavailable');
  assert.equal((await captureDecision({ getCapturePolicy: () => store.read() })).reason, 'policy_unavailable');
  writer.update({ enabled: true, disabledSources: [] });
  assert.equal(store.read().enabled, true);
  rmSync(path);
  assert.deepEqual(store.read(), { enabled: true, disabledSources: [], ...ALL_PROJECTS, updatedAt: null });
});

test('the settings generation moves on every change and never returns to "never saved"', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-generation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path);
  const seen = [store.version()];
  assert.equal(seen[0], 'absent', 'no settings were ever saved');
  assert.equal(store.version(), seen[0], 'nothing changed');
  store.update({ enabled: false, disabledSources: [] });
  seen.push(store.version());
  const bytes = readFileSync(path);
  rmSync(path);
  seen.push(store.version());
  writeFileSync(path, bytes);
  seen.push(store.version());
  assert.equal(store.version(), seen.at(-1), 'an unchanged file keeps its generation');
  writeFileSync(join(directory, 'capture-settings-generation.json'), '{ not json');
  seen.push(store.version());
  assert.equal(new Set(seen).size, seen.length, `every change is a new generation: ${seen.join(', ')}`);
  assert.equal(seen.slice(1).includes('absent'), false, 'a removed file is not "never saved"');
});

// rec#5 C2: a project switch is a settings change like any other, so turns
// written while a project was off are never imported later.
test('every project mode or list change moves the settings generation by one', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-capture-project-generation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'capture-policy.json');
  const store = new CapturePolicyStore(path);
  const generation = () => JSON.parse(readFileSync(join(directory, 'capture-settings-generation.json'), 'utf8')).generation;
  const seen = [];
  for (const change of [{ enabled: true }, { projectMode: 'all_except', excludedProjectIds: ['job-hunt'] },
    { excludedProjectIds: [] }, { projectMode: 'selected' }, { selectedProjectIds: ['thesis'] },
    { unregisteredDirectories: 'capture' }, { projectMode: 'all' }]) {
    store.update(change);
    seen.push([generation(), store.version()]);
  }
  assert.deepEqual(seen.map(([value]) => value), [1, 2, 3, 4, 5, 6, 7], 'one step per save, as for the global switch');
  assert.equal(new Set(seen.map(([, version]) => version)).size, seen.length);
  assert.equal(store.version(), seen.at(-1)[1], 'reading changes nothing');
});
