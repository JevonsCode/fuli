import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

const compiler = process.env.SystemRoot && join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const windowsOnly = { skip: process.platform !== 'win32' };
const windowsWithCompiler = { skip: process.platform !== 'win32' || !compiler || !existsSync(compiler) };
// A run that is not about the deadline gets a budget no fixture start reaches.
const RUN_BUDGET_MS = 60_000;
const FIRST_DEADLINE_MS = 1500, LAST_DEADLINE_MS = 24_000;

// What one deadline trial must show. The runner's verdict, its time bound, reclaiming the
// controller and CLI (whichever had started) and the recovery run apply to every trial;
// only the preserved service needs the whole controller -> CLI -> service tree, which the
// CLI proves by recording the service after spawning it. Returns whether the tree formed.
function assertDeadlineTrial({ scenario, deadline, result, cli, alive }) {
  const label = `${scenario} at ${deadline} ms: `;
  assert.equal(result.reply.ok, false, label + 'the runner reports failure');
  assert.match(result.reply.error, /timed out/, label + 'the runner reports its deadline');
  assert.match(result.reply.error, /may still be running/, label + 'the runner warns about services');
  // The deadline plus the equal cleanup budget, with margin: output EOF is covered too.
  assert.ok(result.elapsedMs < 2 * deadline + 1000, label + 'Deadline covers output EOF as well as process exit');
  assert.deepEqual(alive.filter(row => row.role === 'controller' || row.role === 'cli'), [], label + 'controller and CLI reclaimed');
  if (scenario === 'hang') assert.equal(result.recovery?.ok, true, label + 'Runner is usable after timeout');
  if (!cli) return false;
  assert.ok(alive.some(row => row.role === 'service' && row.pid === cli.service), label + 'A service descendant must survive controller/CLI cleanup');
  return true;
}

// A trial whose tree did not form still had to pass every check that applied to it;
// only then does a longer deadline get its chance.
async function deadlineTrials(trial) {
  for (let deadline = FIRST_DEADLINE_MS; ; deadline *= 2) {
    const observation = await trial(deadline);
    if (assertDeadlineTrial(observation)) return observation;
    assert.ok(deadline < LAST_DEADLINE_MS, 'The fixture tree never formed before the runner deadline');
  }
}

test('a deadline trial without a fixture tree still fails on its own faults before any retry', async () => {
  const timedOut = deadline => ({ ok: false, error: `Controller or output timed out (${deadline} ms). Started Fuli services may still be running.` });
  const normal = deadline => ({ scenario: 'hang', deadline, cli: { pid: 11, service: 12 },
    result: { reply: timedOut(deadline), elapsedMs: deadline + 50, recovery: { ok: true } }, alive: [{ pid: 12, role: 'service' }] });
  const unformed = (deadline, change) => ({ ...normal(deadline), cli: null, alive: [], ...change(deadline) });
  const faults = {
    'the runner did not time out': () => ({ result: { reply: { ok: true, label: 'running' }, elapsedMs: 10, recovery: { ok: true } } }),
    'the runner overran its deadline': deadline => ({ result: { reply: timedOut(deadline), elapsedMs: 5 * deadline, recovery: { ok: true } } }),
    'the controller survived': () => ({ alive: [{ pid: 10, role: 'controller' }] }),
    'an unrecorded CLI survived': () => ({ alive: [{ pid: 11, role: 'cli' }] }),
    'the runner was unusable afterwards': deadline => ({ result: { reply: timedOut(deadline), elapsedMs: deadline, recovery: { ok: false } } })
  };
  for (const [fault, change] of Object.entries(faults)) {
    const trials = [];
    await assert.rejects(deadlineTrials(async deadline => {
      trials.push(deadline);
      return trials.length === 1 ? unformed(deadline, change) : normal(deadline);
    }), assert.AssertionError, fault);
    assert.deepEqual(trials, [FIRST_DEADLINE_MS], fault + ': a later normal trial must not mask it');
  }
  const trials = [];
  const formed = await deadlineTrials(async deadline => {
    trials.push(deadline);
    return trials.length === 1 ? unformed(deadline, () => ({})) : normal(deadline);
  });
  assert.equal(formed.deadline, 2 * FIRST_DEADLINE_MS);
  assert.throws(() => assertDeadlineTrial({ ...normal(1500), alive: [] }), /service descendant must survive/);
});

test('fixture cleanup finds a service whose parent exited and whose PID record is late or missing', windowsOnly, async t => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fuli-tray-cleanup-')));
  const node = join(root, 'runtime', 'node', 'node.exe');
  await mkdir(dirname(node), { recursive: true });
  await copyFile(process.execPath, node);
  // Another executable whose command line names this root must never be touched.
  const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', root], { stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    outsider.kill();
    await cleanupFixture(node, root);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  for (const record of ['late', 'missing']) {
    await rm(join(root, 'service.pid'), { force: true });
    const service = join(root, 'service.js');
    await writeFile(service, record === 'late'
      ? `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(join(root, 'service.pid'))},String(process.pid)),200);setInterval(()=>{},1000);`
      : 'setInterval(()=>{},1000);');
    // The parent records nothing and exits as soon as the detached service exists.
    const parent = spawn(node, ['-e', `require('node:child_process').spawn(process.execPath,[${JSON.stringify(service)}],{detached:true,stdio:'ignore'}).unref();`],
      { stdio: 'ignore', windowsHide: true });
    assert.deepEqual(await once(parent, 'exit'), [0, null]);
    assert.equal((await fixtureProcesses(node, root)).length, 1, record + ': the orphaned service is running');
    await cleanupFixture(node, root);
    assert.deepEqual(await fixtureProcesses(node, root), [], record + ': the orphaned service was stopped');
    assert.equal(outsider.exitCode, null, record + ': an unrelated process survives');
    process.kill(outsider.pid, 0);
  }
});

test('Windows tray controller has one bounded execution/pipe lifetime and preserves services', windowsWithCompiler, async t => {
  // Windows reports a process image by its real path, so derive the fixture executable from the
  // same real path (a junctioned or macOS-style aliased TEMP otherwise fails the ownership check).
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'fuli-tray-runner-')));
  const node = join(root, 'runtime', 'node', 'node.exe');
  const scripts = join(root, 'src', 'desktop');
  await mkdir(dirname(node), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await copyFile(process.execPath, node);
  const harness = join(root, 'Probe.cs');
  // args: root, deadline (ms) for the controller run, [recover]. The runner keeps no
  // per-instance state, so the recovery run checks the same process with its own budget.
  // The probe reports through probe.json and runs without stdio: the preserved service
  // was observed holding the probe's stdout pipe, so waiting for its EOF lasted until this
  // test's process timeout and cut slow probes short (the tray, a GUI app, has no such pipe).
  await writeFile(harness, `using System;using System.Diagnostics;using System.IO;using System.Text;using System.Web.Script.Serialization;
class Probe {
 static ControllerReply Run(ControllerRunner runner) {
  try {return runner.Run("status");} catch(Exception e) {return new ControllerReply{ok=false,error=e.Message};}
 }
 static void Main(string[] args) {
 var deadline=int.Parse(args[1]); var clock=Stopwatch.StartNew();
 var reply=Run(new ControllerRunner(args[0],deadline,deadline));
 var elapsed=clock.ElapsedMilliseconds; ControllerReply recovery=null;
 if(args.Length>2){File.Copy(Path.Combine(args[0],"recovery.js"),Path.Combine(args[0],"src","desktop","windows-controller.js"),true);recovery=Run(new ControllerRunner(args[0],${RUN_BUDGET_MS},3000));}
 File.WriteAllText(Path.Combine(args[0],"probe.json"),new JavaScriptSerializer().Serialize(new {reply,elapsedMs=elapsed,recovery}),new UTF8Encoding(false));
} }`);
  const probe = join(root, 'Probe.exe');
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
    '/out:' + probe, resolve('desktop/windows/ControllerRunner.cs'), harness], 60_000);
  t.after(async () => {
    await cleanupFixture(node, root);
    assert.equal(dirname(root), realpathSync(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const file = name => join(root, name);
  const controllerScript = join(scripts, 'windows-controller.js');
  const roleOf = commandLine => commandLine.includes(controllerScript) ? 'controller'
    : commandLine.includes(file('cli.js')) ? 'cli' : commandLine.includes(file('service.js')) ? 'service' : 'other';
  const success = 'process.stderr.write("诊断".repeat(100000));process.stdout.write(JSON.stringify({ok:true,label:"运行中 / Running"})+"\\n");';
  await writeFile(file('recovery.js'), success);
  await writeFile(file('service.js'), `require('node:fs').writeFileSync(${JSON.stringify(file('service.pid'))},String(process.pid));setInterval(()=>{},1000);`);

  await t.test('success', async () => {
    await writeFile(controllerScript, success);
    const result = await probeRun(RUN_BUDGET_MS);
    assert.equal(result.reply.ok, true);
    assert.equal(result.reply.label, '运行中 / Running');
    t.diagnostic(JSON.stringify({ scenario: 'success', elapsedMs: result.elapsedMs }));
  });

  for (const scenario of ['hang', 'inherited-pipe']) {
    await t.test(scenario, async () => {
      const { deadline, result } = await deadlineTrials(deadline => deadlineTrial(scenario, deadline));
      t.diagnostic(JSON.stringify({ scenario, deadline, elapsedMs: result.elapsedMs, bounded: true,
        servicePreserved: true, recovery: result.recovery?.ok ?? null }));
    });
  }

  // Everything a trial is judged on is observed before its cleanup runs.
  async function deadlineTrial(scenario, deadline) {
    for (const name of ['controller.pid', 'cli.json', 'service.pid']) await rm(file(name), { force: true });
    await writeFile(file('cli.js'), `const fs=require('node:fs'),cp=require('node:child_process');const service=cp.spawn(process.execPath,[${JSON.stringify(file('service.js'))}],{detached:true,stdio:${JSON.stringify(scenario === 'inherited-pipe' ? 'inherit' : 'ignore')}});fs.writeFileSync(${JSON.stringify(file('cli.json'))},JSON.stringify({pid:process.pid,service:service.pid}));setInterval(()=>{},1000);`);
    await writeFile(controllerScript, `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(file('controller.pid'))},String(process.pid));cp.spawn(process.execPath,[${JSON.stringify(file('cli.js'))}],{detached:true,stdio:'inherit'});${scenario === 'hang' ? 'setInterval(()=>{},1000);' : `const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file('cli.json'))})){process.stdout.write(JSON.stringify({ok:true,label:'running'})+'\\n');process.exit(0)}},10);`}`);
    try {
      const result = await probeRun(deadline, scenario === 'hang');
      const cli = await readFile(file('cli.json'), 'utf8').then(JSON.parse).catch(() => null);
      const alive = (await fixtureProcesses(node, root)).map(row => ({ pid: row.pid, role: roleOf(row.commandLine) }));
      return { scenario, deadline, result, cli, alive };
    } finally { await cleanupFixture(node, root); }
  }

  // The bound only stops a broken probe; a working one ends at its own exit.
  async function probeRun(deadline, recover = false) {
    await rm(file('probe.json'), { force: true });
    const child = spawn(probe, [root, String(deadline), ...(recover ? ['recover'] : [])], { windowsHide: true, stdio: 'ignore' });
    const bound = setTimeout(() => child.kill(), 2 * deadline + (recover ? RUN_BUDGET_MS : 0) + 30_000);
    try {
      const [code, signal] = await once(child, 'exit');
      assert.equal(code, 0, 'Probe exited with ' + (code ?? signal));
    } finally { clearTimeout(bound); }
    return JSON.parse(await readFile(file('probe.json'), 'utf8'));
  }
});

// Every fixture process runs this root's own copy of node.exe with this root on its command
// line. Windows reuses PIDs quickly (a fresh conhost.exe can take an exited fixture's PID), so
// a PID alone never proves ownership.
function mine(observed, node, root) {
  return observed?.executable?.toLowerCase() === node.toLowerCase() && Boolean(observed.commandLine?.includes(root));
}

// One process snapshot, scoped by the root's unique executable path and command line. It
// reaches processes whose parents already exited and that never recorded their PID.
async function fixtureProcesses(node, root) {
  const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);'
    + '$rows=@(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.ExecutablePath -eq $env:FULI_FIXTURE_NODE }'
    + ' | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;commandLine=[string]$_.CommandLine} });'
    + 'ConvertTo-Json -InputObject $rows -Compress';
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stdout = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], 60_000, { ...process.env, FULI_FIXTURE_NODE: node });
  return JSON.parse(stdout.replace(/^﻿/, '').trim() || '[]').filter(row => row.commandLine.includes(root));
}

// Recorded PIDs (controller.pid, cli.json, service.pid) and the snapshot both name candidates;
// each is re-identified before it is stopped. Repeats until no fixture process is left, so a
// process spawned while a pass ran is still reached.
async function cleanupFixture(node, root) {
  const recorded = async name => {
    const text = await readFile(join(root, name), 'utf8').catch(() => null);
    if (!text) return [];
    try { const value = JSON.parse(text); return typeof value === 'number' ? [value] : [value?.pid, value?.service]; } catch { return []; }
  };
  for (let pass = 0; pass < 5; pass += 1) {
    const candidates = new Set([...(await recorded('controller.pid')), ...(await recorded('cli.json')), ...(await recorded('service.pid'))]
      .filter(pid => Number.isInteger(pid) && pid > 0));
    for (const row of await fixtureProcesses(node, root)) candidates.add(row.pid);
    let stopped = 0;
    for (const pid of candidates) {
      const observed = await inspectWindowsNativeProcess(pid);
      if (!mine(observed, node, root)) continue;
      await stopWindowsNativeProcess(pid, { pid, command: observed.executable, ownership: observed });
      stopped += 1;
    }
    if (!stopped) break;
  }
  assert.deepEqual(await fixtureProcesses(node, root), [], 'fixture cleanup confirmed');
}

function run(command, args, timeout, env = process.env) {
  return new Promise((resolveRun, reject) => execFile(command, args, {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env
  }, (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolveRun(stdout)));
}
