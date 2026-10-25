// Synthetic fixtures only: a temporary native transcript, a real capture policy
// file and a Provider double with the cursor and owner rules of the real one.
import assert from 'node:assert/strict';
import fs, { chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { runCodexLifecycleHook } from '../src/agents/codex/lifecycle-hook.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../src/graphiti/capture-policy.js';
import { notRecordedEvent, notRecordedReason, transcriptCaptureLedger, TURN_UNRESOLVED, UNATTRIBUTABLE }
  from '../src/conversations/transcript-capture-gap.js';
import { transcriptDigest, TRANSCRIPT_PAGES_PER_HOOK } from '../src/conversations/transcript-guard.js';

const header = JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }) + '\n';
const row = (role, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }) + '\n';

// The production hook gives each capture window 750 ms. On a loaded runner
// the real guard, lock and fsync I/O alone can outlast that, and the hook then
// defers the import on purpose (CI job 118455374209). These tests are about
// which turns are imported, so they give the window far more time than any
// I/O needs; an expired window is tested on its own at the end of this file.
const FUNCTIONAL_CAPTURE_MS = 30_000;

// newTaskPerEntry: each task entry begins a new task (task-1, task-2, ...),
// as the Provider does, instead of keeping one task for the whole session.
async function session(t, { saved = true, newTaskPerEntry = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-capture-gap-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const policyPath = capturePolicyPathForRuntime(runtimeConfigPath);
  const transcript = join(directory, 'transcript.jsonl');
  await writeFile(transcript, header);
  const store = new CapturePolicyStore(policyPath);
  if (saved) store.update({ enabled: true, disabledSources: [] });
  let cursor = header.length;
  // Each saved event keeps the task token it was written under.
  const appended = [];
  const tasks = { current: newTaskPerEntry ? 'task-0' : 'task', entered: 0 };
  // entry.during runs inside each task entry, before the entry returns its task.
  const entry = { during: null };
  // The whole Provider can be unreachable: project lookups, task lookups and
  // conversation writes then all fail with a network error.
  // A held request answers only when the test releases it (see holdNext()).
  const provider = { up: true, hold: null };
  const reach = () => { if (!provider.up) throw new TypeError('fetch failed'); };
  const answer = (operation, request) => {
    if (request.mode === 'policy') return { enabled: true };
    if (request.mode === 'session') return { cursor, initialized: true };
    if (request.expected_cursor !== cursor) throw new Error('CAS mismatch');
    if (operation === 'append') {
      // The Provider keeps one event per ID; a retried page must match it.
      for (const event of request.events) {
        const saved = appended.find(item => item.event_id === event.event_id);
        if (saved && saved.content !== event.content) throw new Error('Conversation event ID has different content');
        if (!saved) appended.push({ ...event, token: request.task_context_token });
      }
      cursor = request.cursor;
      return { status: 'saved' };
    }
    // The Provider's fallback omission: one content-free marker, then the cursor moves.
    if (request.fallback_recovery) {
      appended.push({ event_id: `jsonl-v1:${request.expected_cursor}:${request.cursor}:fallback`, token: request.task_context_token,
        content: `[Visible transcript content omitted: unverified task ownership after fallback; bytes ${request.expected_cursor} to ${request.cursor} remain in native history.]` });
      cursor = request.cursor;
      return { status: 'saved' };
    }
    return { status: 'bound', cursor };
  };
  const app = { config: { personal: { spaceId: 'space' } },
    getCapturePolicy: () => store.read(), getCapturePolicyVersion: () => store.version(),
    advanceCapturePolicyVersion: () => store.advanceVersion(),
    resolveProjectPath: async () => { reach(); return { status: 'matched', basis: 'repository_root', personalProjectId: 'project' }; },
    personal: {
      currentTaskContext: async () => { reach(); return { personal_project_id: 'project', project_agent_id: 'lead', token: tasks.current, entry_via: 'hook' }; },
      conversation: async (operation, request) => {
        reach();
        const hold = provider.hold;
        if (!hold?.matches(operation, request)) return answer(operation, request);
        provider.hold = null; hold.reached(); await hold.released;
        try { return answer(operation, request); } finally { hold.settle(); }
      }
    } };
  const notices = [];
  const hook = (event, prompt, { signal } = {}) => runCodexLifecycleHook(['--event', event], { write: () => {},
    readInput: async () => ({ transcript_path: transcript, session_id: 'session', cwd: directory,
      ...(prompt === undefined ? {} : { prompt }) }),
    captureTimeoutMs: FUNCTIONAL_CAPTURE_MS, signal,
    resolveRuntimeOptions: () => ({ runtimeConfigPath }), openApplication: () => app,
    createLeases: () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} }),
    callTool: async (_app, name) => {
      if (name !== 'begin_task_context') return {};
      if (newTaskPerEntry) tasks.current = `task-${++tasks.entered}`;
      await entry.during?.();
      return { taskContextToken: tasks.current };
    } })
    .then(output => { if (output?.systemMessage) notices.push(output.systemMessage); return output; });
  // One host turn: the prompt is written, the entry hook runs, the reply is
  // written and the Stop hook runs.
  const turn = async (prompt, reply, { hooks = true } = {}) => {
    await appendFile(transcript, row('user', prompt));
    if (hooks) await hook('UserPromptSubmit', prompt);
    await appendFile(transcript, row('assistant', reply));
    if (hooks) await hook('Stop');
  };
  // Holds the next Provider request that matches until release() is called;
  // settled resolves once the Provider has answered it (or refused it).
  const holdNext = matches => {
    let reached, release, settle;
    const wasReached = new Promise(resolve => { reached = resolve; });
    const settled = new Promise(resolve => { settle = resolve; });
    provider.hold = { matches, reached, settle, released: new Promise(resolve => { release = resolve; }) };
    return { wasReached, release, settled };
  };
  return { app, store, policyPath, runtimeConfigPath, directory, transcriptPath: transcript, appended, turn, hook, holdNext,
    notices, provider, tasks, entry,
    contents: () => appended.map(event => event.content),
    markers: () => appended.filter(event => event.event_id.endsWith(':not_recorded')) };
}

// Content-free: a reason and a byte range. A settings change is not called "off".
const MARKER = /^\[Not recorded: (the capture state could not be saved safely, so this stretch was skipped|automatic recording was off \((global_off|client_off|policy_unavailable|project_off|project_unregistered)\)|capture settings changed, so this stretch could not be confirmed as allowed and was skipped); native bytes \d+ to \d+ remain in native history\.\]$/;
const SKIPPED_NOTICE = 'Fuli: 记录设置有变动，无法确认这段是否允许记录，已跳过';

// What the hooks told the host, so a failure says whether a capture was
// deferred, a handoff was pending or a cursor write failed.
const hookNotices = s => `hook notices:\n${s.notices.join('\n') || '(none)'}`;

function assertOnlyOnPeriodTurns(s) {
  assert.deepEqual(s.contents().filter(text => !text.startsWith('[')), ['on before', 'answer before', 'on after', 'answer after'],
    hookNotices(s));
  assert.equal(s.contents().some(text => text.includes('private')), false, 'no off-period turn is imported');
  for (const marker of s.markers()) assert.match(marker.content, MARKER);
}

for (const { name, off } of [
  { name: 'switched off', off: s => s.store.update({ enabled: false, disabledSources: [] }) },
  { name: 'switched off for this client', off: s => s.store.update({ enabled: true, disabledSources: ['codex'] }) },
  { name: 'unreadable', off: s => writeFile(s.policyPath, '{ not json') }
]) {
  test(`turns written while capture is ${name} are skipped, marked and never imported later`, async (t) => {
    const s = await session(t);
    await s.turn('on before', 'answer before');
    await off(s);
    await s.turn('private one', 'private answer one');
    await s.turn('private two', 'private answer two');
    assert.ok(s.markers().length > 0, 'the skipped interval is marked while capture is off');
    s.store.update({ enabled: true, disabledSources: [] });
    await s.turn('on after', 'answer after');
    assertOnlyOnPeriodTurns(s);
    const settled = s.appended.length;
    await s.hook('Stop');
    await s.hook('Stop');
    assert.equal(s.appended.length, settled, 'a repeated sync adds nothing');
  });
}

test('turns written while no hook saw capture off are not imported once it is back on', async (t) => {
  const s = await session(t);
  await s.turn('on before', 'answer before');
  s.store.update({ enabled: false, disabledSources: [] });
  await s.turn('private one', 'private answer one', { hooks: false });
  s.store.update({ enabled: true, disabledSources: [] });
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  assert.equal(s.markers().length, 1, `the unattributable interval is marked instead\n${hookNotices(s)}`);
  assert.ok(s.notices.includes(SKIPPED_NOTICE), 'the hook that skipped the stretch says so');
});

test('a policy file removed after an unobserved off period does not look like settings never saved', async (t) => {
  const s = await session(t, { saved: false });
  await s.turn('on before', 'answer before');
  s.store.update({ enabled: false, disabledSources: [] });
  await appendFile(s.transcriptPath, row('user', 'private one') + row('assistant', 'private answer one'));
  await rm(s.policyPath);
  await s.hook('Stop');
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  assert.equal(s.markers().length, 1, hookNotices(s));
  assert.ok(s.notices.includes(SKIPPED_NOTICE), 'the hook that skipped the stretch says so');
});

// dot's #228 review: a denial the Provider could not take a marker for, while
// the settings never changed, must still never be imported once it is back.
test('turns denied while the Provider was unreachable are not imported after it recovers', async (t) => {
  const s = await session(t);
  s.store.update({ projectMode: 'selected', selectedProjectIds: ['project'] });
  await s.turn('on before', 'answer before');
  s.provider.up = false;
  await s.turn('private one', 'private answer one');
  assert.equal(s.markers().length, 0, 'no marker could reach the Provider');
  s.provider.up = true;
  await s.hook('Stop');
  assert.equal(s.contents().some(text => text.includes('private')), false, 'nothing from the outage is imported');
  assert.equal(s.markers().length, 1, 'the denied stretch is marked once the Provider is back');
  assert.match(s.markers()[0].content, /automatic recording was off \(policy_unavailable\)/);
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  const settled = s.appended.length;
  await s.hook('Stop');
  assert.equal(s.appended.length, settled, 'a repeated sync adds nothing');
});

test('a denial that cannot be kept locally still imports nothing later', async (t) => {
  const s = await session(t);
  s.store.update({ projectMode: 'selected', selectedProjectIds: ['project'] });
  await s.turn('on before', 'answer before');
  s.provider.up = false;
  // The ledger directory is replaced by a file, so no ledger can be written or read there.
  const ledgers = join(dirname(s.policyPath), 'transcript-capture');
  await rm(ledgers, { recursive: true, force: true });
  await writeFile(ledgers, 'not a directory');
  await s.turn('private one', 'private answer one');
  s.provider.up = true;
  await s.hook('Stop');
  assert.equal(s.contents().some(text => text.includes('private')), false);
});

// Makes an existing file refuse replacement and deletion while it stays
// readable, as dot's review did with a read-only (0500) directory. Windows
// does not honour that mode, so there another handle holds the file open
// without write or delete sharing: a real refusal by the OS either way.
// Returns the release, or null when this account is not refused.
async function refuseChanges(file) {
  if (process.platform !== 'win32') {
    const directory = dirname(file);
    chmodSync(directory, 0o500);
    try {
      await writeFile(join(directory, '.probe'), '');
      chmodSync(directory, 0o700);
      return null;
    } catch {
      return async () => chmodSync(directory, 0o700);
    }
  }
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f = [IO.File]::Open($env:FULI_REFUSED_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $f.Close()"],
  { env: { ...process.env, FULI_REFUSED_FILE: file }, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', data => { if (String(data).includes('ready')) resolve(); });
    holder.on('error', reject);
  });
  return async () => {
    const exited = new Promise(resolve => holder.on('exit', resolve));
    holder.stdin.end('\n');
    await exited;
  };
}

// Runs a step with files that refuse changes, releasing them before the
// fixture's own cleanup removes the directory.
async function withRefusedFiles(t, files, step) {
  const releases = [];
  try {
    for (const file of files) {
      const release = await refuseChanges(file);
      if (!release) return t.skip('this account can write into a read-only directory, so the OS refusal cannot be reproduced');
      releases.push(release);
    }
    return await step();
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

const ledgerFile = async s => {
  const directory = join(dirname(s.policyPath), 'transcript-capture');
  // The format lock beside the ledger holds no data (rec#17).
  return join(directory, (await readdir(directory)).find((name) => name.endsWith('.json')));
};
const STATE_UNSAVED_NOTICE = 'Fuli: 记录状态未能安全保存，本会话后续内容暂不导入';

// dot's re-check of #228: the denial cannot be kept, the old successful record
// cannot be removed and stays readable, and the Provider cannot take a marker.
test('a denial that cannot be kept beside an old record that cannot be removed is still never imported', async (t) => {
  const s = await session(t);
  s.store.update({ projectMode: 'selected', selectedProjectIds: ['project'] });
  await s.turn('on before', 'answer before');
  const before = s.store.version();
  await withRefusedFiles(t, [await ledgerFile(s)], async () => {
    s.provider.up = false;
    await s.turn('private one', 'private answer one');
    assert.ok(s.notices.some(text => text.includes(STATE_UNSAVED_NOTICE)), 'the hook says the denial was not safely kept');
    assert.notEqual(s.store.version(), before, 'the settings generation moved instead, for every process');
    s.provider.up = true;
    await s.hook('Stop');
    assert.equal(s.contents().some(text => text.includes('private')), false, 'nothing from the denied stretch is imported');
  });
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
});

test('when nothing local can be written the hook says so and this process imports nothing', async (t) => {
  const s = await session(t);
  s.store.update({ projectMode: 'selected', selectedProjectIds: ['project'] });
  await s.turn('on before', 'answer before');
  // The settings generation is kept beside the policy file, outside the ledger directory.
  const generation = join(dirname(s.policyPath), 'capture-settings-generation.json');
  await withRefusedFiles(t, [await ledgerFile(s), generation], async () => {
    const before = s.store.version();
    s.provider.up = false;
    await s.turn('private one', 'private answer one');
    assert.ok(s.notices.some(text => text.includes('Fuli: 记录状态无法写入本地')), s.notices.join('\n'));
    assert.equal(s.store.version(), before, 'no newer generation could be saved either');
    s.provider.up = true;
    await s.hook('Stop');
    assert.equal(s.contents().some(text => text.includes('private')), false, 'this process keeps skipping');
  });
});

// An expired capture window, without relying on load: a Provider read is held
// while the hook's deadline fires (the same cancel path as the window's own
// timer in capture-window.js), then answered late. The late continuation must
// write nothing, and the next sync must decide the stretch afresh.
async function stopWithExpiredCapture(s) {
  const hold = s.holdNext((_operation, request) => request.mode === 'session');
  const deadline = new AbortController();
  const stop = s.hook('Stop', undefined, { signal: deadline.signal });
  await hold.wasReached;
  const before = s.appended.length;
  deadline.abort();
  await stop;
  assert.ok(s.notices.some(text => text.includes('Native transcript import was deferred')), hookNotices(s));
  hold.release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(s.appended.length, before, 'the late continuation writes nothing');
}

test('an on-period turn whose Stop capture expired is imported by the next Stop', async (t) => {
  const s = await session(t);
  await s.turn('on before', 'answer before');
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await s.hook('UserPromptSubmit', 'on after');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  await stopWithExpiredCapture(s);
  assert.equal(s.contents().includes('answer after'), false, 'nothing is imported while the capture is deferred');
  await s.hook('Stop');
  assertOnlyOnPeriodTurns(s);
  assert.equal(s.markers().length, 0, 'settings never changed, so nothing is skipped');
});

test('an off-period Stop whose capture expired never lets that turn be imported later', async (t) => {
  const s = await session(t);
  await s.turn('on before', 'answer before');
  s.store.update({ enabled: false, disabledSources: [] });
  await appendFile(s.transcriptPath, row('user', 'private one'));
  await s.hook('UserPromptSubmit', 'private one');
  await appendFile(s.transcriptPath, row('assistant', 'private answer one'));
  // The denial is kept locally before the window opens; only its marker is late.
  await stopWithExpiredCapture(s);
  s.store.update({ enabled: true, disabledSources: [] });
  await s.turn('on after', 'answer after');
  assertOnlyOnPeriodTurns(s);
  assert.ok(s.markers().length > 0, 'the off stretch is marked once capture is back');
});

// rec#16 (1): an entry whose window expires in its handoff still enters its
// task. The held Provider request is the old task's tail page, in flight
// when the deadline fires; it answers only after the next Stop has finished.
const visible = s => s.appended.filter(event => !event.content.startsWith('['));
const guardState = async s => {
  const directory = join(dirname(s.runtimeConfigPath), 'transcript-guards');
  const files = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.json'));
  return files.length ? JSON.parse(await readFile(join(directory, files[0]), 'utf8')) : null;
};

async function entryWithExpiredHandoff(s, prompt, matches) {
  await appendFile(s.transcriptPath, row('user', prompt));
  const hold = s.holdNext(matches);
  const deadline = new AbortController();
  const entry = s.hook('UserPromptSubmit', prompt, { signal: deadline.signal });
  await hold.wasReached;
  deadline.abort();
  await entry;
  assert.ok(s.notices.at(-1).includes('Native transcript import was deferred'), hookNotices(s));
  return hold;
}

test('an entry whose capture expired in its handoff is finished by the entered task\'s Stop', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  const hold = await entryWithExpiredHandoff(s, 'on after', operation => operation === 'append');
  const kept = await guardState(s);
  assert.equal(kept.phase, 'ready', 'the window expired after the prompt was found, before the old tail was flushed');
  assert.equal(kept.nextOwner, transcriptDigest('task-2'), 'the guard names the task the entry entered');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  await s.hook('Stop');
  assert.deepEqual(visible(s).map(event => [event.content, event.token]), [['on before', 'task-1'], ['answer before', 'task-1'],
    ['on after', 'task-2'], ['answer after', 'task-2']], hookNotices(s));
  assert.equal(s.appended.length, visible(s).length, 'nothing is marked: the old task had no unflushed tail');
  assert.equal(await guardState(s), null, 'the handoff is finished');
  // The late page answers now: the Provider refuses its stale cursor.
  const before = s.appended.length;
  hold.release();
  await hold.settled;
  assert.equal(s.appended.length, before, 'the late request writes nothing');
  await s.hook('Stop');
  assert.equal(s.appended.length, before, 'a repeated Stop adds nothing');
});

test('an expired handoff outlives the guard lifetime: a Stop long after its entry still finishes it', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await entryWithExpiredHandoff(s, 'on after', operation => operation === 'append');
  // The entered task's turn runs for longer than the guard's 60 s lifetime.
  const directory = join(dirname(s.runtimeConfigPath), 'transcript-guards');
  const [name] = (await readdir(directory)).filter(file => file.endsWith('.json'));
  const kept = JSON.parse(await readFile(join(directory, name), 'utf8'));
  await writeFile(join(directory, name), JSON.stringify({ ...kept, createdAt: Date.now() - 10 * 60_000 }));
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  await s.hook('Stop');
  assert.deepEqual(visible(s).slice(2).map(event => [event.content, event.token]),
    [['on after', 'task-2'], ['answer after', 'task-2']], hookNotices(s));
});

test('an expired handoff marks the old task\'s unflushed tail omitted and imports the entered task\'s turn', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  // The old task's reply is never synced by its own Stop, so the entry has to flush it.
  await appendFile(s.transcriptPath, row('user', 'on before'));
  await s.hook('UserPromptSubmit', 'on before');
  await appendFile(s.transcriptPath, row('assistant', 'answer before'));
  const hold = await entryWithExpiredHandoff(s, 'on after', operation => operation === 'append');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  await s.hook('Stop');
  assert.deepEqual(visible(s).map(event => [event.content, event.token]), [['on after', 'task-2'], ['answer after', 'task-2']],
    hookNotices(s));
  const omitted = s.appended.filter(event => event.event_id.endsWith(':fallback'));
  assert.equal(omitted.length, 1, 'the old tail is one content-free omission');
  assert.equal(omitted[0].token, 'task-2');
  // Its page was in flight with the old task's text: it never lands.
  hold.release();
  await hold.settled;
  assert.equal(s.appended.some(event => event.content.includes('answer before')), false, 'the late page writes nothing');
});

// The entry hook for `prompt`, with its deadline fired when the scan opens the
// native transcript for its first page, before it reads any byte of it.
async function entryCutInScan(t, s, prompt) {
  const deadline = new AbortController();
  const promises = (await import('node:fs/promises')).default;
  const open = promises.open;
  let armed = true;
  t.mock.method(promises, 'open', (path, ...rest) => {
    if (armed && String(path) === s.transcriptPath) { armed = false; deadline.abort(); }
    return open(path, ...rest);
  });
  syncBuiltinESMExports();
  try {
    await s.hook('UserPromptSubmit', prompt, { signal: deadline.signal });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(armed, false, 'the deadline fired inside the scan');
  assert.ok(s.notices.at(-1).includes('Native transcript import was deferred'), hookNotices(s));
}

test('an entry whose window expires mid-scan leaves the scan to the entered task\'s Stop', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await entryCutInScan(t, s, 'on after');
  const kept = await guardState(s);
  assert.equal(kept.phase, 'scan', 'the prompt was not found before the deadline');
  assert.equal(kept.nextOwner, transcriptDigest('task-2'));
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  await s.hook('Stop');
  assert.deepEqual(visible(s).slice(2).map(event => [event.content, event.token]),
    [['on after', 'task-2'], ['answer after', 'task-2']], hookNotices(s));
  assert.equal(s.markers().length, 0);
  assert.equal(await guardState(s), null);
});

// dot's follow-up to fuli#278: Codex runs the prompt hook before it writes the
// prompt to the transcript, so the cut scan never sees the prompt. entryEnd is
// the native EOF the hook measures after task entry returns and before it
// returns itself, not a snapshot from when its capture started: the prompt
// lies after it when Codex writes it once the hook returned, and before it
// when Codex writes it while the task entry still runs. Either way the
// entered task's Stop imports the whole turn and marks nothing.
for (const { when, duringEntry } of [
  { when: 'after the hook returns', duringEntry: false },
  { when: 'while the task entry runs', duringEntry: true }
]) {
  test(`Codex order: a scan cut before the prompt is on disk is continued when the prompt is written ${when}`, async (t) => {
    const s = await session(t, { newTaskPerEntry: true });
    await s.turn('on before', 'answer before');
    const promptStart = (await stat(s.transcriptPath)).size;
    const prompt = row('user', 'on after');
    const writePrompt = () => appendFile(s.transcriptPath, prompt);
    if (duringEntry) s.entry.during = writePrompt;
    await entryCutInScan(t, s, 'on after');
    s.entry.during = null;
    const kept = await guardState(s);
    assert.equal(kept.phase, 'scan', 'the scan was cut before it read a byte');
    assert.equal(kept.scanCursor, promptStart);
    assert.equal(kept.nextOwner, transcriptDigest('task-2'));
    assert.equal(kept.entryEnd, duringEntry ? promptStart + Buffer.byteLength(prompt) : promptStart,
      'entryEnd is the EOF once task entry returned');
    if (!duringEntry) await writePrompt();
    await appendFile(s.transcriptPath, row('assistant', 'answer after'));
    await s.hook('Stop');
    assert.deepEqual(visible(s).map(event => [event.content, event.token]), [['on before', 'task-1'], ['answer before', 'task-1'],
      ['on after', 'task-2'], ['answer after', 'task-2']], hookNotices(s));
    assert.equal(s.appended.length, visible(s).length, 'nothing is omitted or marked');
    assert.equal(await guardState(s), null, 'the handoff is finished');
  });
}

// Events per native transcript page (readTranscriptBatch in transcript-reader.js).
const PAGE_EVENTS = 50;
const assistantRows = (count, prefix) => Array.from({ length: count }, (_, index) => row('assistant', `${prefix} ${index}`));

// Both sides of an expired handoff need more pages than one hook reads: the
// old task's unflushed tail the scan crosses, then the entered task's turn.
// Each hook continues from the progress the guard and the cursor saved.
test('an expired handoff whose scan and import each span more than one hook\'s pages is finished across hooks', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  const longer = TRANSCRIPT_PAGES_PER_HOOK * PAGE_EVENTS + 10;
  await appendFile(s.transcriptPath, row('user', 'on before'));
  await s.hook('UserPromptSubmit', 'on before');
  // The old task's turn is never synced by its own Stop.
  await appendFile(s.transcriptPath, assistantRows(longer, 'old answer').join(''));
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await entryCutInScan(t, s, 'on after');
  const reply = assistantRows(longer, 'new answer');
  await appendFile(s.transcriptPath, reply.join(''));

  await s.hook('Stop');
  const scanning = await guardState(s);
  assert.equal(scanning.phase, 'scan', 'one hook\'s pages do not reach the prompt');
  assert.equal(scanning.scanPages, TRANSCRIPT_PAGES_PER_HOOK);
  assert.deepEqual(s.appended, [], 'nothing is written while the boundary is unknown');

  await s.hook('Stop');
  assert.equal(await guardState(s), null, 'the next hook found the prompt and finished the handoff');
  const omitted = s.appended.filter(event => event.event_id.endsWith(':fallback'));
  assert.equal(omitted.length, 1, 'the old tail is one content-free omission');
  assert.equal(visible(s).length, TRANSCRIPT_PAGES_PER_HOOK * PAGE_EVENTS, 'one hook imports at most its pages');

  await s.hook('Stop');
  const expected = ['on after', ...reply.map((_, index) => `new answer ${index}`)];
  assert.deepEqual(visible(s).map(event => event.content), expected, hookNotices(s));
  assert.ok(visible(s).every(event => event.token === 'task-2'), 'the whole turn is the entered task\'s');
  assert.equal(s.contents().some(text => text.includes('old answer')), false, 'no old-task text is imported');
  assert.equal(s.markers().length, 0);
  const settled = s.appended.length;
  await s.hook('Stop');
  assert.equal(s.appended.length, settled, 'a repeated Stop adds nothing');
});

test('the next entry finishes an expired handoff first, then hands off its own prompt', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await entryWithExpiredHandoff(s, 'on after', operation => operation === 'append');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  // The entered task's Stop never runs; the next prompt comes first.
  await s.turn('on next', 'answer next');
  assert.deepEqual(visible(s).slice(2).map(event => [event.content, event.token]),
    [['on after', 'task-2'], ['answer after', 'task-2'], ['on next', 'task-3'], ['answer next', 'task-3']], hookNotices(s));
  assert.equal(s.appended.length, visible(s).length);
});

// rec#16 (2): a Stop whose window expired just before recording went off.
// The held Provider request is that Stop's session read.
async function stopExpiredBefore(s, { meanwhile = () => {} } = {}) {
  const hold = s.holdNext((_operation, request) => request.mode === 'session');
  const deadline = new AbortController();
  const stop = s.hook('Stop', undefined, { signal: deadline.signal });
  await hold.wasReached;
  await meanwhile();
  deadline.abort();
  await stop;
  assert.ok(s.notices.at(-1).includes('Native transcript import was deferred'), hookNotices(s));
  return hold;
}

const notRecordedRanges = s => s.markers().map(event => {
  const [, from, to] = /native bytes (\d+) to (\d+)/.exec(event.content);
  return { from: Number(from), to: Number(to), reason: notRecordedReason(event.content), token: event.token };
});

test('an on-period turn whose Stop expired before recording went off is imported, and only the off bytes are marked off', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await s.hook('UserPromptSubmit', 'on after');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  const hold = await stopExpiredBefore(s);
  const offFrom = (await stat(s.transcriptPath)).size;
  s.store.update({ enabled: false, disabledSources: [] });
  await s.turn('private one', 'private answer one');
  s.store.update({ enabled: true, disabledSources: [] });
  await s.turn('on later', 'answer later');
  hold.release();
  await hold.settled;
  assert.deepEqual(visible(s).map(event => [event.content, event.token]), [['on before', 'task-1'], ['answer before', 'task-1'],
    ['on after', 'task-2'], ['answer after', 'task-2'], ['on later', 'task-4'], ['answer later', 'task-4']], hookNotices(s));
  assert.equal(s.contents().some(text => text.includes('private')), false, 'no off-period byte is imported');
  const ranges = notRecordedRanges(s);
  assert.ok(ranges.length > 0, 'the off period is marked');
  for (const range of ranges) {
    assert.equal(range.reason, 'global_off');
    assert.ok(range.from >= offFrom, `an off marker never covers the on-period turn (${range.from} < ${offFrom})`);
  }
});

test('an expired Stop whose settings changed meanwhile marks its bytes unconfirmed, not off', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await s.hook('UserPromptSubmit', 'on after');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  const onEnd = (await stat(s.transcriptPath)).size;
  // Recording goes off while the Stop is still deciding: the generation it decided under is gone.
  const hold = await stopExpiredBefore(s, { meanwhile: () => s.store.update({ enabled: false, disabledSources: [] }) });
  await s.turn('private one', 'private answer one');
  hold.release();
  await hold.settled;
  assert.equal(s.contents().some(text => text.includes('answer after') || text.includes('private')), false,
    'nothing it cannot prove is imported');
  const ranges = notRecordedRanges(s);
  assert.deepEqual(ranges[0], { from: ranges[0].from, to: onEnd, reason: UNATTRIBUTABLE, token: 'task-2' }, hookNotices(s));
  assert.ok(ranges.slice(1).every(range => range.reason === 'global_off' && range.from >= onEnd));
});

// dot's follow-up to fuli#278: a settings generation that cannot be read is
// null, and null proves no decision, not even when it equals the null an
// expired Stop decided under. Its bytes are marked unconfirmed, never imported
// and never called off. The generation fails to read only around that Stop.
const unreadableGeneration = s => { s.app.getCapturePolicyVersion = () => { throw new Error('synthetic unreadable generation'); }; };
const readableGeneration = s => { s.app.getCapturePolicyVersion = () => s.store.version(); };
for (const { when, decided, kept } of [
  { when: 'when the Stop decided and when it kept its bytes', decided: unreadableGeneration, kept: () => {} },
  { when: 'only when the Stop decided', decided: unreadableGeneration, kept: readableGeneration },
  { when: 'only when the Stop kept its bytes', decided: () => {}, kept: unreadableGeneration }
]) {
  test(`an expired Stop whose generation could not be read ${when} marks its bytes unconfirmed`, async (t) => {
    const s = await session(t, { newTaskPerEntry: true });
    await s.turn('on before', 'answer before');
    await appendFile(s.transcriptPath, row('user', 'on after'));
    await s.hook('UserPromptSubmit', 'on after');
    await appendFile(s.transcriptPath, row('assistant', 'answer after'));
    const onEnd = (await stat(s.transcriptPath)).size;
    decided(s);
    const hold = await stopExpiredBefore(s, { meanwhile: () => kept(s) });
    readableGeneration(s);
    hold.release();
    await hold.settled;
    s.store.update({ enabled: false, disabledSources: [] });
    await s.turn('private one', 'private answer one');
    assert.equal(s.contents().some(text => text.includes('answer after') || text.includes('private')), false,
      'nothing it cannot prove is imported');
    const ranges = notRecordedRanges(s);
    assert.deepEqual(ranges[0], { from: ranges[0].from, to: onEnd, reason: UNATTRIBUTABLE, token: 'task-2' }, hookNotices(s));
    assert.ok(ranges.length > 1 && ranges.slice(1).every(range => range.reason === 'global_off' && range.from >= onEnd),
      'only the bytes written after it are marked off');
  });
}

test('an expired Stop\'s bytes are never imported under a task entered after it', async (t) => {
  const s = await session(t, { newTaskPerEntry: true });
  await s.turn('on before', 'answer before');
  await appendFile(s.transcriptPath, row('user', 'on after'));
  await s.hook('UserPromptSubmit', 'on after');
  await appendFile(s.transcriptPath, row('assistant', 'answer after'));
  const hold = await stopExpiredBefore(s);
  hold.release();
  await hold.settled;
  const onEnd = (await stat(s.transcriptPath)).size;
  s.store.update({ enabled: false, disabledSources: [] });
  // The off entry cannot reach the Provider to cover them, and still enters task-3.
  await appendFile(s.transcriptPath, row('user', 'private one'));
  s.provider.up = false;
  await s.hook('UserPromptSubmit', 'private one');
  s.provider.up = true;
  assert.equal(s.tasks.current, 'task-3');
  await appendFile(s.transcriptPath, row('assistant', 'private answer one'));
  await s.hook('Stop');
  assert.equal(s.contents().some(text => text.includes('answer after') || text.includes('private')), false, hookNotices(s));
  const ranges = notRecordedRanges(s);
  assert.deepEqual(ranges[0], { from: ranges[0].from, to: onEnd, reason: TURN_UNRESOLVED, token: 'task-3' });
  assert.ok(ranges.slice(1).every(range => range.reason === 'global_off' && range.from >= onEnd));
});

test('an expired Stop while a turn is held keeps it held and never imports it in an off period', async (t) => {
  const s = await session(t);
  await s.turn('on before', 'answer before');
  const ledger = transcriptCaptureLedger(s.runtimeConfigPath, { session_id: 'session' }, 'codex');
  assert.equal(ledger.holdTurn({ turn: 'held-turn', from: (await stat(s.transcriptPath)).size }), 'ledger');
  await appendFile(s.transcriptPath, row('user', 'held prompt') + row('assistant', 'held answer'));
  const hold = await stopExpiredBefore(s);
  hold.release();
  await hold.settled;
  assert.deepEqual(ledger.heldTurns().turns.map(turn => turn.turn), ['held-turn'], 'the turn stays held');
  s.store.update({ enabled: false, disabledSources: [] });
  await s.turn('private one', 'private answer one');
  assert.equal(s.contents().some(text => text.includes('held') || text.includes('private')), false, hookNotices(s));
  assert.equal(notRecordedRanges(s)[0].reason, TURN_UNRESOLVED);
});

test('unresolved turns are held in order, skip every sync and end only as a whole after the last of them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-unresolved-turn-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const ledger = transcriptCaptureLedger(runtimeConfigPath, { session_id: 'synthetic-session' }, 'claude_code');
  ledger.record('v1');
  assert.equal(await ledger.skipReason('v1'), null);
  assert.equal(ledger.holdTurn({ turn: 'turn-1', from: 120 }), 'ledger');
  ledger.ownTurn('turn-1', 'a'.repeat(64));
  assert.equal(ledger.holdTurn({ turn: 'turn-2', from: 180 }), 'ledger');
  assert.deepEqual(ledger.heldTurns(), { unprovable: false, skipUntil: null,
    turns: [{ turn: 'turn-1', from: 120, owner: 'a'.repeat(64) }, { turn: 'turn-2', from: 180, owner: null }] });
  assert.equal(await ledger.skipReason('v1'), TURN_UNRESOLVED);
  // A covering sync and a denial keep them: only their own end does.
  ledger.record('v1');
  assert.equal(await ledger.deny('v1', 'session_paused'), 'kept');
  assert.equal(ledger.heldTurns().turns.length, 2);
  ledger.record('v1');
  assert.equal(await ledger.skipReason('v1'), TURN_UNRESOLVED);
  // Only the last held turn ends them, so an older turn's evidence never ends a newer turn.
  assert.equal(ledger.endTurns('turn-1'), false);
  assert.equal(ledger.heldTurns().turns.length, 2);
  assert.equal(ledger.endTurns('turn-2'), true);
  assert.deepEqual(ledger.heldTurns(), { unprovable: false, turns: [], skipUntil: null });
  assert.equal(await ledger.skipReason('v1'), null);
  // A fresh entry ends what was held and leaves a byte nothing before may be imported.
  ledger.holdTurn({ turn: 'turn-3', from: 240 });
  assert.equal(ledger.enteredAfter(300, ledger.entrySnapshot()), true);
  assert.deepEqual(ledger.heldTurns(), { unprovable: false, turns: [], skipUntil: 300 });
  assert.equal(await ledger.skipReason('v1'), TURN_UNRESOLVED);
  ledger.skipped(300);
  assert.equal(await ledger.skipReason('v1'), null);
  // Every write is version 2.
  const [name] = (await readdir(join(directory, 'transcript-capture'))).filter((entry) => entry.endsWith('.json'));
  assert.equal(JSON.parse(await readFile(join(directory, 'transcript-capture', name), 'utf8')).version, 2);
  // The skipped stretch names the reason and no content.
  const marker = notRecordedEvent(240, 300, TURN_UNRESOLVED);
  assert.match(marker.content, /task ownership was not confirmed, so it was not recorded under any task; native bytes 240 to 300/);
  assert.equal(notRecordedReason(marker.content), TURN_UNRESOLVED);
});

test('an expired capture\'s decision stays in version 2, is dropped by a covering sync and is never trusted when invalid', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-unsynced-span-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const ledger = transcriptCaptureLedger(runtimeConfigPath, { session_id: 'synthetic-session' }, 'claude_code');
  const owner = 'a'.repeat(64);
  ledger.record('v1');
  ledger.observeUnsynced({ until: 120, owner });
  assert.deepEqual(ledger.unsyncedSpan(), { until: 120, owner });
  const [name] = (await readdir(join(directory, 'transcript-capture'))).filter((entry) => entry.endsWith('.json'));
  const file = join(directory, 'transcript-capture', name);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2, settings: 'v1', unsynced: { until: 120, owner } });
  // A turn held before its end may belong to another task: skipped as unresolved, not imported.
  ledger.holdTurn({ turn: 'turn-1', from: 100 });
  assert.deepEqual(ledger.unsyncedSpan(), { until: 120, reason: TURN_UNRESOLVED });
  ledger.endTurns('turn-1');
  // A denial keeps it; a sync that covered the transcript drops it.
  assert.equal(await ledger.deny('v2', 'global_off'), 'kept');
  assert.deepEqual(ledger.unsyncedSpan(), { until: 120, owner });
  ledger.record('v2');
  assert.equal(ledger.unsyncedSpan(), null);
  // Only a token digest or a reason code: anything else is dropped and never imports.
  for (const unsynced of [{ until: 5, reason: 'Some words' }, { until: 5, owner: 'not-a-digest' },
    { until: 5, owner, reason: 'global_off' }, { until: -1, owner }]) {
    await writeFile(file, JSON.stringify({ version: 2, settings: 'v2', unsynced }));
    assert.equal(ledger.unsyncedSpan(), null, JSON.stringify(unsynced));
  }
  // Never written over a record that cannot be proven.
  await writeFile(file, '{not json');
  ledger.observeUnsynced({ until: 130, owner });
  assert.equal(await readFile(file, 'utf8'), '{not json');
  assert.equal(ledger.unsyncedSpan(), null);
});

test('a ledger that cannot be proven holds the session, and an unwritable one falls back to its own hold', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-unprovable-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const ledger = transcriptCaptureLedger(runtimeConfigPath, { session_id: 'synthetic-session' }, 'claude_code');
  ledger.record('v1');
  const [name] = (await readdir(join(directory, 'transcript-capture'))).filter((entry) => entry.endsWith('.json'));
  const file = join(directory, 'transcript-capture', name);
  for (const [label, content] of [['corrupt', '{not json'], ['newer version', JSON.stringify({ version: 3, settings: 'v1' })],
    ['invalid held state', JSON.stringify({ version: 2, settings: 'v1', held: [{ turn: '' }] })]]) {
    await writeFile(file, content);
    assert.equal(ledger.heldTurns().unprovable, true, label);
    assert.equal(await ledger.skipReason('v1'), TURN_UNRESOLVED, label);
  }
  // A newer version is never rewritten; a corrupt one is replaced only by a record that stays held.
  await writeFile(file, JSON.stringify({ version: 3, settings: 'v1' }));
  ledger.record('v1');
  assert.equal(await readFile(file, 'utf8'), JSON.stringify({ version: 3, settings: 'v1' }));
  await writeFile(file, '{not json');
  ledger.record('v1');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 2, settings: 'v1', unprovable: true });
  assert.equal(ledger.heldTurns().unprovable, true);
  // A fresh entry proves the state again.
  assert.equal(ledger.enteredAfter(10, ledger.entrySnapshot()), true);
  assert.equal(ledger.heldTurns().unprovable, false);
  // The record cannot be written: the turn is kept in its own hold, which holds the session as unprovable.
  await rm(file);
  await mkdir(file);
  assert.equal(ledger.heldTurns().unprovable, true, 'an unreadable record is not absent');
  await rm(file, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 3 }));
  assert.equal(ledger.holdTurn({ turn: 'turn-f', from: 5 }), 'fallback');
  await rm(file);
  assert.equal(ledger.heldTurns().unprovable, true, 'the fallback hold alone holds the session');
  assert.equal(ledger.enteredAfter(20, ledger.entrySnapshot()), true);
  assert.equal(ledger.heldTurns().unprovable, false);
});

test('a task entry ends only what it observed: turns and fallback holds written since stay held', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-entry-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const ledger = transcriptCaptureLedger(runtimeConfigPath, { session_id: 'synthetic-session' }, 'claude_code');
  ledger.holdTurn({ turn: 'observed', from: 10 });
  const snapshot = ledger.entrySnapshot();
  ledger.holdTurn({ turn: 'held-meanwhile', from: 20 });
  assert.equal(ledger.enteredAfter(30, snapshot), true);
  assert.deepEqual(ledger.heldTurns().turns.map(turn => turn.turn), ['held-meanwhile']);
  // A fallback hold written after the entry started is not the one it observed.
  const [name] = (await readdir(join(directory, 'transcript-capture'))).filter((entry) => entry.endsWith('.json'));
  const file = join(directory, 'transcript-capture', name);
  await writeFile(file, JSON.stringify({ version: 3 }));
  assert.equal(ledger.holdTurn({ turn: 'fallback-1', from: 40 }), 'fallback');
  const withFallback = ledger.entrySnapshot();
  assert.equal(ledger.holdTurn({ turn: 'fallback-2', from: 50 }), 'fallback');
  ledger.enteredAfter(60, withFallback);
  assert.equal(ledger.heldTurns().unprovable, true, 'the newer fallback hold and the newer ledger stay');
  // Unchanged since the entry observed them, both are cleared.
  await rm(file);
  const unchanged = ledger.entrySnapshot();
  assert.equal(ledger.enteredAfter(70, unchanged), true);
  assert.deepEqual(ledger.heldTurns(), { unprovable: false, turns: [], skipUntil: 70 });
});

// dot, rec#10 6327529328: the denial's fallback removal checks and removes
// under one hold of the lock, so a turn held after the failed write survives.
test('a denial whose write fails never removes a turn another process held meanwhile', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-deny-race-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const runtimeConfigPath = join(directory, 'runtime.json');
  const input = { session_id: 'synthetic-session' };
  const ledger = transcriptCaptureLedger(runtimeConfigPath, input, 'claude_code');
  const other = transcriptCaptureLedger(runtimeConfigPath, input, 'claude_code');
  ledger.record('generation-1');
  const lockDirectory = join(directory, 'transcript-capture');
  const [name] = (await readdir(lockDirectory)).filter((entry) => entry.endsWith('.json'));
  const file = join(lockDirectory, name);
  const originals = { mkdirSync: fs.mkdirSync, lstatSync: fs.lstatSync };
  let failed = false;
  let held = false;
  t.mock.method(fs, 'mkdirSync', (path, ...rest) => {
    if (!failed && String(path).startsWith(lockDirectory)) {
      failed = true;
      throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    }
    return originals.mkdirSync(path, ...rest);
  });
  t.mock.method(fs, 'lstatSync', (path, ...rest) => {
    // Between the failed write and the removal, another hook holds a turn.
    if (failed && !held && String(path) === file) {
      held = true;
      assert.equal(other.holdTurn({ turn: 'held-meanwhile', from: 5 }), 'ledger');
    }
    return originals.lstatSync(path, ...rest);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = await ledger.deny('generation-2', 'session_paused');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(failed && held, true, 'the write failed and the hold landed in between');
  assert.equal(result, 'unkept');
  assert.deepEqual(other.heldTurns().turns.map(turn => turn.turn), ['held-meanwhile']);
});
