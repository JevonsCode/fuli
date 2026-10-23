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
// A run that is not about the deadline gets a budget no fixture start reaches.
const RUN_BUDGET_MS = 60_000;
test('Windows tray controller has one bounded execution/pipe lifetime and preserves services', {
  skip: process.platform !== 'win32' || !compiler || !existsSync(compiler)
}, async t => {
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
    await cleanup();
    assert.equal(dirname(root), realpathSync(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const file = name => join(root, name);
  const success = 'process.stderr.write("诊断".repeat(100000));process.stdout.write(JSON.stringify({ok:true,label:"运行中 / Running"})+"\\n");';
  await writeFile(file('recovery.js'), success);
  await writeFile(file('service.js'), `require('node:fs').writeFileSync(${JSON.stringify(file('service.pid'))},String(process.pid));setInterval(()=>{},1000);`);

  await t.test('success', async () => {
    await writeFile(join(scripts, 'windows-controller.js'), success);
    const result = await probeRun(RUN_BUDGET_MS);
    assert.equal(result.reply.ok, true);
    assert.equal(result.reply.label, '运行中 / Running');
    t.diagnostic(JSON.stringify({ scenario: 'success', elapsedMs: result.elapsedMs }));
  });

  for (const scenario of ['hang', 'inherited-pipe']) {
    await t.test(scenario, async () => {
      // The assertions need the whole controller -> CLI -> service tree to exist when the
      // deadline fires. The CLI records the service only after spawning it, so its record
      // proves that; without it the trial says nothing and repeats with a longer deadline.
      for (let deadline = 1500; ; deadline *= 2) {
        const trial = await deadlineTrial(scenario, deadline);
        if (!trial) {
          assert.ok(deadline < 24_000, 'The fixture tree never formed before the runner deadline');
          continue;
        }
        const { result, cli } = trial;
        try {
          assert.equal(result.reply.ok, false);
          assert.match(result.reply.error, /timed out/);
          assert.match(result.reply.error, /may still be running/);
          // The deadline plus the equal cleanup budget, with margin: output EOF is covered too.
          assert.ok(result.elapsedMs < 2 * deadline + 1000, 'Deadline covers output EOF as well as process exit');
          const controller = Number(await readFile(file('controller.pid'), 'utf8'));
          for (const [name, pid] of [['controller', controller], ['cli', cli.pid]]) assert.equal(await ours(pid), null, name + ' reclaimed');
          assert.ok(await ours(cli.service), 'A service descendant must survive controller/CLI cleanup');
          if (scenario === 'hang') assert.equal(result.recovery.ok, true, 'Runner is usable after timeout');
          t.diagnostic(JSON.stringify({ scenario, deadline, elapsedMs: result.elapsedMs, bounded: true,
            servicePreserved: true, recovery: result.recovery?.ok ?? null }));
        } finally { await cleanup(); }
        return;
      }
    });
  }

  async function deadlineTrial(scenario, deadline) {
    for (const name of ['controller.pid', 'cli.json', 'service.pid']) await rm(file(name), { force: true });
    await writeFile(file('cli.js'), `const fs=require('node:fs'),cp=require('node:child_process');const service=cp.spawn(process.execPath,[${JSON.stringify(file('service.js'))}],{detached:true,stdio:${JSON.stringify(scenario === 'inherited-pipe' ? 'inherit' : 'ignore')}});fs.writeFileSync(${JSON.stringify(file('cli.json'))},JSON.stringify({pid:process.pid,service:service.pid}));setInterval(()=>{},1000);`);
    await writeFile(join(scripts, 'windows-controller.js'), `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(file('controller.pid'))},String(process.pid));cp.spawn(process.execPath,[${JSON.stringify(file('cli.js'))}],{detached:true,stdio:'inherit'});${scenario === 'hang' ? 'setInterval(()=>{},1000);' : `const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file('cli.json'))})){process.stdout.write(JSON.stringify({ok:true,label:'running'})+'\\n');process.exit(0)}},10);`}`);
    let result;
    try { result = await probeRun(deadline, scenario === 'hang'); } catch (error) { await cleanup(); throw error; }
    const cli = await readFile(file('cli.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (!cli) await cleanup();
    return cli && { result, cli };
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

  // Every fixture process descends from the controller, whose PID is recorded before it
  // spawns anything; the service also records itself. Only this root's processes stop.
  async function cleanup() {
    const controller = await readFile(file('controller.pid'), 'utf8').then(Number).catch(() => null);
    const service = await readFile(file('service.pid'), 'utf8').then(Number).catch(() => null);
    const rows = new Map();
    if (controller) for (const row of await inspectWindowsNativeProcess(controller, { descendants: true })) rows.set(row.pid, row);
    if (service && !rows.has(service)) rows.set(service, await inspectWindowsNativeProcess(service));
    for (const observed of rows.values()) {
      if (!mine(observed)) continue;
      await stopWindowsNativeProcess(observed.pid, { pid: observed.pid, command: observed.executable, ownership: observed });
      assert.equal(await ours(observed.pid), null, observed.pid + ' fixture cleanup confirmed');
    }
  }

  // Windows reuses PIDs quickly (a fresh conhost.exe can take an exited
  // fixture's PID), so "our fixture is still running" means this executable
  // with this root on its command line, not just a live PID.
  function mine(observed) {
    return observed?.executable?.toLowerCase() === node.toLowerCase() && Boolean(observed.commandLine?.includes(root));
  }
  async function ours(pid) {
    const observed = await inspectWindowsNativeProcess(pid);
    return mine(observed) ? observed : null;
  }
});

function run(command, args, timeout) {
  return new Promise((resolveRun, reject) => execFile(command, args, {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024
  }, (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolveRun(stdout)));
}
