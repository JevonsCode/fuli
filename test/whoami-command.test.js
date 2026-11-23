import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runWhoAmICommand } from '../src/cli/whoami-command.js';
import { projectIdentity } from '../src/system/project-identity.js';
import { projectIdentityCache } from '../src/system/project-identity-cache.js';
import { RUNNER_FILE, RunnerStore } from '../src/runner/runner-store.js';

// A made-up space, project and FLA; no real names or paths anywhere here.
const ANSWER = Object.freeze({
  space: { id: 'space-7f3', name: 'Workshop' },
  project: { id: 'proj-blue', name: 'Blue Kettle' },
  lead: { id: 'agent-21', name: 'Rowan Vale', role: 'Kettle lead' },
  projectResolution: 'matched', basis: 'git_origin'
});
const FIELDS = ['space', 'project', 'lead', 'projectResolution', 'basis', 'computer', 'offline', 'answeredAt'];

const dataDir = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-whoami-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const answered = (body = ANSWER) => async () => ({ ok: true, status: 200, json: async () => body });
const lines = () => { const written = []; return { written, write: (line) => written.push(line) }; };

test('whoami on the host answers the folder it runs in, with no token or address', async (t) => {
  const asked = [];
  const output = lines();
  const result = await runWhoAmICommand([], {
    env: { FULI_DATA_DIR: dataDir(t) },
    write: output.write,
    cwd: () => '/work/blue-kettle',
    isRunner: () => false,
    fetchImpl: async (url, request) => { asked.push([url, JSON.parse(request.body)]); return (await answered()(url, request)); }
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(asked[0][1], { projectPath: '/work/blue-kettle' });
  assert.match(asked[0][0], /\/api\/whoami$/);
  const text = output.written.join('\n');
  assert.match(text, /Space: Workshop \(space-7f3\)/);
  assert.match(text, /Project: Blue Kettle \(proj-blue\)/);
  assert.match(text, /Lead FLA: Rowan Vale, Kettle lead \(agent-21\)/);
  assert.match(text, /This computer: the FULI host/);
  assert.doesNotMatch(text, /token|certificate|127\.0\.0\.1/i);
});

test('--project takes a project ID or a folder, and --json is the same answer', async (t) => {
  const asked = [];
  const record = async (url, request) => { asked.push(JSON.parse(request.body)); return (await answered()(url, request)); };
  const output = lines();
  const options = { env: { FULI_DATA_DIR: dataDir(t) }, write: output.write, cwd: () => '/work/elsewhere',
    isRunner: () => false, fetchImpl: record };
  await runWhoAmICommand(['--project', 'proj-blue'], options);
  await runWhoAmICommand(['--project', '/work/blue-kettle', '--json'], options);
  assert.deepEqual(asked, [{ personalProjectId: 'proj-blue' }, { projectPath: '/work/blue-kettle' }]);
  const shown = JSON.parse(output.written.at(-1));
  // Every field is always there, so a script never tests for a missing key.
  assert.deepEqual(Object.keys(shown), FIELDS);
  assert.deepEqual(shown.project, ANSWER.project);
  assert.deepEqual(shown.computer, { role: 'host', hostReachable: null });
  assert.equal(shown.offline, false);
  assert.equal(typeof shown.answeredAt, 'string');
});

test('an unmatched folder still has every field, with null where there is nothing', async (t) => {
  const output = lines();
  await runWhoAmICommand(['--json'], { env: { FULI_DATA_DIR: dataDir(t) }, write: output.write, cwd: () => '/work/loose',
    isRunner: () => false, fetchImpl: answered({ space: { id: 'space-7f3', name: 'Workshop' }, project: null, lead: null,
      projectResolution: 'unmatched' }) });
  const shown = JSON.parse(output.written[0]);
  assert.deepEqual(Object.keys(shown), FIELDS);
  assert.deepEqual([shown.project, shown.lead, shown.basis, shown.projectResolution], [null, null, null, 'unmatched']);
});

test('a runner asks the host with its folder\'s facts, and keeps the answer for when the host is away', async (t) => {
  const directory = dataDir(t);
  const sent = [];
  const output = lines();
  const options = { env: { FULI_DATA_DIR: directory }, write: output.write, cwd: () => '/runner/blue-kettle',
    isRunner: () => true, workspaceFacts: async (path) => ({ version: 1, path }) };
  await runWhoAmICommand([], { ...options,
    fetchImpl: async (url, request) => { sent.push(JSON.parse(request.body)); return (await answered()(url, request)); } });
  assert.deepEqual(sent, [{ projectPath: '/runner/blue-kettle', workspace: { version: 1, path: '/runner/blue-kettle' } }]);
  assert.match(output.written.join('\n'), /This computer: a runner; its FULI is on the host \(answering\)/);

  // The host is away now: the earlier answer is shown, said to be earlier.
  const away = lines();
  const result = await runWhoAmICommand(['--json'], { ...options, write: away.write,
    fetchImpl: async () => { throw new Error('host unreachable'); } });
  // An earlier answer is usable but not current: its own exit code, beside the offline field.
  assert.equal(result.exitCode, 3);
  const shown = JSON.parse(away.written[0]);
  assert.deepEqual(shown.project, ANSWER.project);
  assert.deepEqual(shown.computer, { role: 'runner', hostReachable: false });
  assert.equal(shown.offline, true);
  assert.equal(typeof shown.answeredAt, 'string');
  assert.ok(projectIdentityCache(directory).last('/runner/blue-kettle'), 'the answer is kept under the folder asked about');
});

test('a refusal the console explains is repeated to the person, not swallowed', async (t) => {
  const output = lines();
  const result = await runWhoAmICommand([], {
    env: { FULI_DATA_DIR: dataDir(t) }, write: output.write, cwd: () => '/work/gone',
    isRunner: () => false,
    fetchImpl: async () => ({ ok: false, status: 400,
      json: async () => ({ error: { message: 'projectPath must be an existing absolute directory' } }) })
  });
  assert.equal(result.exitCode, 2);
  assert.match(output.written.join('\n'), /the console answered 400: projectPath must be an existing absolute directory/);
});

test('a host that revoked this computer is not "away": its earlier answers are not shown', async (t) => {
  const directory = dataDir(t);
  projectIdentityCache(directory).remember('/runner/blue-kettle', ANSWER);
  mkdirSync(join(directory, 'runner'), { recursive: true });
  const store = new RunnerStore(join(directory, RUNNER_FILE));
  store.saveHost({ name: 'Host A', fingerprint: 'f'.repeat(64), certPem: 'synthetic', port: 2730, addresses: ['192.0.2.20'] });
  store.revoked();
  store.close();
  const output = lines();
  const result = await runWhoAmICommand([], { env: { FULI_DATA_DIR: directory }, write: output.write, cwd: () => '/runner/blue-kettle',
    isRunner: () => true, workspaceFacts: async () => ({ version: 1 }), fetchImpl: async () => { throw new Error('host refused'); } });
  assert.equal(result.exitCode, 2);
});

test('a runner with no earlier answer says so instead of inventing one', async (t) => {
  const output = lines();
  const result = await runWhoAmICommand([], {
    env: { FULI_DATA_DIR: dataDir(t) }, write: output.write, cwd: () => '/runner/other',
    isRunner: () => true, workspaceFacts: async () => ({ version: 1 }),
    fetchImpl: async () => { throw new Error('host unreachable'); }
  });
  assert.equal(result.exitCode, 2);
  assert.match(output.written.join('\n'), /No answer: host unreachable\./);
  assert.match(output.written.join('\n'), /fuli runner status/);
});

test('whoami refuses a folder and a project ID together, and an unknown flag', async (t) => {
  const options = { env: { FULI_DATA_DIR: dataDir(t) }, write: () => {}, isRunner: () => false };
  await assert.rejects(() => runWhoAmICommand(['--nope'], options), /Invalid whoami option/);
  await assert.rejects(() => runWhoAmICommand(['--project'], options), /Missing value/);
  await assert.rejects(() => projectIdentity({}, { projectPath: '/work/x', personalProjectId: 'proj-blue' }),
    /Name a folder or a project ID, not both/);
});

test('the lead is named by the FLA\'s own name, not its role', async () => {
  const app = {
    config: { personal: { spaceId: 'space-7f3' } },
    personal: {
      listSpaces: async () => [{ id: 'space-7f3', name: 'Workshop' }],
      listPersonalProjects: async () => [{ project_id: 'proj-blue', profile: { name: 'Blue Kettle' } }],
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'agent-21' }),
      getProjectAgent: async () => ({ agent_id: 'agent-21', profile: { name: 'Kettle lead', display_name: 'Rowan Vale' } })
    }
  };
  const answer = await projectIdentity(app, { personalProjectId: 'proj-blue' });
  assert.deepEqual(answer.lead, { id: 'agent-21', name: 'Rowan Vale', role: 'Kettle lead' });
  assert.equal(answer.basis, 'project_id');
});

test('an unmatched folder says so rather than guessing a project, and a project with no lead says that', async () => {
  const app = {
    config: { personal: { spaceId: 'space-7f3' } },
    personal: {
      listSpaces: async () => [{ id: 'space-7f3', name: 'Workshop' }],
      listPersonalProjects: async () => [{ project_id: 'proj-blue', profile: { name: 'Blue Kettle' } }],
      getProjectAgentCoordinationPolicy: async () => ({}),
      getProjectAgent: async () => null
    }
  };
  const noLead = await projectIdentity(app, { personalProjectId: 'proj-blue' });
  assert.deepEqual(noLead.project, { id: 'proj-blue', name: 'Blue Kettle' });
  assert.equal(noLead.lead, null);
  assert.deepEqual(noLead.space, { id: 'space-7f3', name: 'Workshop' });
  const unknown = await projectIdentity(app, { personalProjectId: 'proj-missing' });
  assert.equal(unknown.project, null);
  assert.equal(unknown.projectResolution, 'unmatched');
});
