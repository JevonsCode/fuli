#!/usr/bin/env node
// How long an installed client hook takes per prompt, end to end: the real
// command line (Claude Code: node <entry> --fuli-claude-lifecycle
// --runtime-config … --event UserPromptSubmit --timeout-ms 28000; Codex:
// --fuli-lifecycle without a timeout) with a synthetic prompt on stdin, from
// spawn to exit, against a throwaway console on a free port with a temporary
// data directory and a synthetic Provider double (rec#132 step 1). Synthetic
// data only; nothing of an installed FULI is read or started.
//
//   node acceptance/hook-forwarding/measure.js [--client claude-code|codex]
//     [--before <checkout of the earlier commit>] [--runs 20] [--warmup 3]
//
// Rows: before (the earlier checkout's entry, console running), after (this
// checkout's entry, console running: forwarded), fallback (this entry, no
// console recorded: run in its own process), console (time the console spent
// on each forwarded call, request to response).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.js';
import { forgetConsole, recordConsole, startSyntheticHookProvider, syntheticHookDataDirectory }
  from '../../test-support/synthetic-hook-provider.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Each client's installed command line (pack-manifest.js).
const CLIENTS = {
  'claude-code': { flags: ['--fuli-claude-lifecycle'], timeout: ['--timeout-ms', '28000'] },
  codex: { flags: ['--fuli-lifecycle'], timeout: [] }
};

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const runs = Number(option('--runs', '20'));
const warmup = Number(option('--warmup', '3'));
const before = option('--before', null);
const client = option('--client', 'claude-code');
if (!CLIENTS[client]) throw new TypeError('--client is claude-code or codex');
const ENTRY = join('src', 'agents', client, 'lifecycle-hook.js');
const ROUTE = `/api/lifecycle-hooks/${client}`;

const provider = await startSyntheticHookProvider();
const fixture = syntheticHookDataDirectory(tmpdir(), provider.url);
const started = await createServer({ port: 0, runtimeConfigPath: fixture.runtimeConfigPath, peer: false });
const consoleTimes = [];
started.server.on('request', (request, response) => {
  if (request.url !== ROUTE) return;
  const at = performance.now();
  response.once('finish', () => consoleTimes.push(performance.now() - at));
});

let session = 0;
function runHook(entry) {
  session += 1;
  const stdin = JSON.stringify({ session_id: `synthetic-measure-${process.pid}-${session}`, hook_event_name: 'UserPromptSubmit',
    cwd: fixture.projectPath, prompt: 'Synthetic prompt: list the steps to rename a function safely.',
    transcript_path: join(fixture.root, `synthetic-${session}.jsonl`) });
  const at = performance.now();
  const child = spawn(process.execPath, [entry, ...CLIENTS[client].flags, '--runtime-config', fixture.runtimeConfigPath,
    '--event', 'UserPromptSubmit', ...CLIENTS[client].timeout], { stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stdin.end(stdin);
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', code => {
      const elapsed = performance.now() - at;
      if (code !== 0 || !stdout.includes('hookSpecificOutput')) fail(new Error(`hook answered ${code}: ${stdout.slice(0, 200)}`));
      else done(elapsed);
    });
  });
}

async function measure(entry, { console: recorded }) {
  if (recorded) recordConsole(fixture.dataDir, { url: started.url });
  else forgetConsole(fixture.dataDir);
  for (let index = 0; index < warmup; index += 1) await runHook(entry);
  consoleTimes.length = 0;
  const times = [];
  for (let index = 0; index < runs; index += 1) times.push(await runHook(entry));
  return times;
}

function summary(name, times) {
  const sorted = [...times].sort((left, right) => left - right);
  const at = quantile => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
  return { name, runs: times.length, medianMs: Math.round(at(0.5)), p95Ms: Math.round(at(0.95)),
    minMs: Math.round(sorted[0]), maxMs: Math.round(sorted.at(-1)) };
}

const rows = [];
try {
  if (before) rows.push(summary('before', await measure(join(resolve(before), ENTRY), { console: true })));
  const after = await measure(join(ROOT, ENTRY), { console: true });
  rows.push(summary('after (forwarded)', after), summary('console (per forwarded call)', [...consoleTimes]));
  rows.push(summary('fallback (no console)', await measure(join(ROOT, ENTRY), { console: false })));
} finally {
  await started.close();
  await provider.close();
  fixture.remove();
}
console.table(rows);
console.log(JSON.stringify({ client, node: process.version, platform: process.platform, runs, warmup, rows }));
