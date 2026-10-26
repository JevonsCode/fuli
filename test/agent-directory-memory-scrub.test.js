import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentDirectorySnapshots } from '../src/agents/directory-snapshots.js';

const SPACE = 'synthetic-space';
const AGENT = { agentId: 'synthetic-agent', memoryScope: 'reviewed_agent', profile: { name: 'Synthetic Agent' } };
const SECRET = 'SYNTHETIC_SOURCE_MEMORY_TO_ERASE';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-memory-scrub-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const open = () => createAgentDirectorySnapshots({ root, providerIdentity: 'https://synthetic.example' });
  const snapshots = open();
  const layer = (revision, summary = SECRET, personalProjectId = null) => ({ personalProjectId, revision,
    current: { revision, memory: { summary }, createdAt: '2026-10-24T00:00:00Z' } });
  const render = (layers, agent = AGENT, personalSpaceId = SPACE) => snapshots.materialize({ personalSpaceId, agent, layers });
  const path = result => join(root, ...result.path.split('/').slice(1));
  const erase = (revisions, currentRevision = Math.max(...revisions), personalProjectId = null) =>
    ({ personalSpaceId: SPACE, agentId: AGENT.agentId, personalProjectId, revisions, currentRevision, deletionId: 'synthetic-deletion' });
  return { root, snapshots, open, layer, render, path, erase };
}
function allText(directory) {
  return readdirSync(directory, { withFileTypes: true }).map(entry => entry.isDirectory()
    ? allText(join(directory, entry.name)) : readFileSync(join(directory, entry.name), 'utf8')).join('\n');
}

test('cleanup immediately removes selected snapshot words and persistently fences a delayed same-revision response', t => {
  const f = fixture(t);
  const result = f.render([f.layer(3)]);
  const directory = f.path(result);
  assert.match(allText(directory), new RegExp(SECRET));
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'current');
  assert.doesNotMatch(allText(directory), new RegExp(SECRET));
  assert.match(readFileSync(join(directory, 'MEMORY.md'), 'utf8'), /expectedRevision 3/);
  const restarted = f.open();
  restarted.materialize({ personalSpaceId: SPACE, agent: AGENT, layers: [f.layer(3)] });
  assert.doesNotMatch(allText(directory), new RegExp(SECRET));
  f.render([f.layer(4, 'New safe memory.')]);
  assert.match(readFileSync(join(directory, 'MEMORY.md'), 'utf8'), /New safe memory\./);
});

test('a later task checkpoint stale mark cannot discard the erased-revision fence', t => {
  const f = fixture(t);
  const result = f.render([f.layer(3)]);
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'current');
  f.snapshots.markStale({ personalSpaceId: SPACE, agentId: AGENT.agentId, revision: 4 });
  f.open().materialize({ personalSpaceId: SPACE, agent: AGENT, layers: [f.layer(3)] });
  assert.doesNotMatch(allText(f.path(result)), new RegExp(SECRET));
});

test('cleanup preserves unselected revisions, other projects, Agents and spaces byte for byte', t => {
  const f = fixture(t);
  const own = f.render([f.layer(5, 'Retained later memory.'), f.layer(3, 'Other project memory.', 'other-project')]);
  const otherAgent = f.render([f.layer(3, 'Other Agent memory.')], { ...AGENT, agentId: 'other-agent' });
  const otherSpace = f.render([f.layer(3, 'Other space memory.')], AGENT, 'other-space');
  const directory = f.path(own);
  const globalBefore = readFileSync(join(directory, 'MEMORY.md'));
  const projectFile = own.files.find(file => file.scope === 'project').file;
  const projectBefore = readFileSync(join(directory, ...projectFile.split('/')));
  const agentBefore = allText(f.path(otherAgent));
  const spaceBefore = allText(f.path(otherSpace));
  assert.equal(f.snapshots.scrubMemory(f.erase([3], 5)).status, 'current');
  assert.deepEqual(readFileSync(join(directory, 'MEMORY.md')), globalBefore);
  assert.deepEqual(readFileSync(join(directory, ...projectFile.split('/'))), projectBefore);
  assert.equal(allText(f.path(otherAgent)), agentBefore);
  assert.equal(allText(f.path(otherSpace)), spaceBefore);
});

test('an older unselected snapshot is retained rather than erasing every revision below the head', t => {
  const f = fixture(t);
  const result = f.render([f.layer(1, 'Earlier unrelated memory.')]);
  const file = join(f.path(result), 'MEMORY.md');
  const before = readFileSync(file);
  assert.equal(f.snapshots.scrubMemory(f.erase([3], 5)).status, 'current');
  assert.deepEqual(readFileSync(file), before);
});

test('replaying cleanup after restoring old snapshot files rebuilds the fence and removes old body bytes', t => {
  const f = fixture(t);
  const result = f.render([f.layer(3, SECRET, 'deleted-project')]);
  const directory = f.path(result);
  const memoryFile = join(directory, ...result.files.find(file => file.scope === 'project').file.split('/'));
  const manifestFile = join(directory, '.fuli-snapshot.json');
  const old = { memory: readFileSync(memoryFile), manifest: readFileSync(manifestFile) };
  const input = f.erase([3], 3, 'deleted-project');
  assert.equal(f.snapshots.scrubMemory(input).status, 'current');
  writeFileSync(memoryFile, old.memory); writeFileSync(manifestFile, old.manifest);
  assert.match(allText(directory), new RegExp(SECRET));
  assert.equal(f.open().scrubMemory(input).status, 'current');
  assert.doesNotMatch(allText(directory), new RegExp(SECRET));
  f.open().materialize({ personalSpaceId: SPACE, agent: AGENT, layers: [f.layer(3, SECRET, 'deleted-project')] });
  assert.doesNotMatch(allText(directory), new RegExp(SECRET));
});

test('cleanup fences a scope with no existing snapshot before a delayed first read arrives', t => {
  const f = fixture(t);
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'current');
  const result = f.render([f.layer(3)]);
  assert.doesNotMatch(allText(f.path(result)), new RegExp(SECRET));
});

test('a busy snapshot stays pending and succeeds when its owned lock is released', t => {
  const f = fixture(t);
  const result = f.render([f.layer(3)]);
  const directory = f.path(result);
  const lock = join(directory, '.fuli-snapshot.lock');
  writeFileSync(lock, 'synthetic lock');
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'busy');
  assert.match(readFileSync(join(directory, 'MEMORY.md'), 'utf8'), new RegExp(SECRET));
  rmSync(lock);
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'current');
  assert.doesNotMatch(allText(directory), new RegExp(SECRET));
});

test('a file whose manifest cannot establish its revision never reports cleanup complete', t => {
  const f = fixture(t);
  const result = f.render([f.layer(3)]);
  const directory = f.path(result);
  writeFileSync(join(directory, '.fuli-snapshot.json'), '{}');
  assert.equal(f.snapshots.scrubMemory(f.erase([3])).status, 'unavailable');
  assert.match(readFileSync(join(directory, 'MEMORY.md'), 'utf8'), new RegExp(SECRET));
});
