import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { inspectWindowsNativeProcess, stopWindowsNativeProcess } from '../src/native-runtime/windows-processes.js';

const compiler = process.env.SystemRoot && join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
test('Windows tray controller has one bounded execution/pipe lifetime and preserves services', {
  skip: process.platform !== 'win32' || !compiler || !existsSync(compiler)
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-tray-runner-'));
  const node = join(root, 'runtime', 'node', 'node.exe');
  const scripts = join(root, 'src', 'desktop');
  await mkdir(dirname(node), { recursive: true });
  await mkdir(scripts, { recursive: true });
  await copyFile(process.execPath, node);
  const harness = join(root, 'Probe.cs');
  await writeFile(harness, `using System;using System.Diagnostics;using System.IO;using System.Text;using System.Web.Script.Serialization;
class Probe { static void Main(string[] args) {
 Console.OutputEncoding=new UTF8Encoding(false);
 var runner=new ControllerRunner(args[0],1500,1500); var clock=Stopwatch.StartNew(); ControllerReply reply;
 try {reply=runner.Run("status");} catch(Exception e) {reply=new ControllerReply{ok=false,error=e.Message};}
 var elapsed=clock.ElapsedMilliseconds; ControllerReply recovery=null;
 if(args.Length>1){File.Copy(Path.Combine(args[0],"recovery.js"),Path.Combine(args[0],"src","desktop","windows-controller.js"),true);recovery=runner.Run("status");}
 Console.WriteLine(new JavaScriptSerializer().Serialize(new {reply,elapsedMs=elapsed,recovery}));
} }`);
  const probe = join(root, 'Probe.exe');
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
    '/out:' + probe, resolve('desktop/windows/ControllerRunner.cs'), harness]);
  t.after(async () => {
    await cleanup();
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const success = 'process.stderr.write("诊断".repeat(100000));process.stdout.write(JSON.stringify({ok:true,label:"运行中 / Running"})+"\\n");';
  await writeFile(join(root, 'recovery.js'), success);
  for (const scenario of ['hang', 'inherited-pipe', 'success']) {
    await t.test(scenario, async () => {
      for (const name of ['controller', 'cli', 'service']) await rm(join(root, name + '.pid'), { force: true });
      await writeFile(join(root, 'service.js'), `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'service.pid'))},String(process.pid));setInterval(()=>{},1000);`);
      await writeFile(join(root, 'cli.js'), `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(join(root, 'cli.pid'))},String(process.pid));cp.spawn(process.execPath,[${JSON.stringify(join(root, 'service.js'))}],{detached:true,stdio:${JSON.stringify(scenario === 'inherited-pipe' ? 'inherit' : 'ignore')}});setInterval(()=>{},1000);`);
      await writeFile(join(scripts, 'windows-controller.js'), scenario === 'success' ? success
        : `const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync(${JSON.stringify(join(root, 'controller.pid'))},String(process.pid));cp.spawn(process.execPath,[${JSON.stringify(join(root, 'cli.js'))}],{detached:true,stdio:'inherit'});${scenario === 'hang' ? 'setInterval(()=>{},1000);' : `const check=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, 'service.pid'))})){process.stdout.write(JSON.stringify({ok:true,label:'running'})+'\\n');process.exit(0)}},10);`}`);
      try {
        const result = JSON.parse(await run(probe, scenario === 'hang' ? [root, 'recover'] : [root]));
        if (scenario === 'success') {
          assert.equal(result.reply.ok, true);
          assert.equal(result.reply.label, '运行中 / Running');
        } else {
          assert.equal(result.reply.ok, false);
          assert.match(result.reply.error, /timed out/);
          assert.match(result.reply.error, /may still be running/);
          assert.ok(result.elapsedMs < 4000, 'Deadline covers output EOF as well as process exit');
          for (const name of ['controller', 'cli']) assert.equal(alive(Number(await readFile(join(root, name + '.pid'), 'utf8'))), false, name + ' reclaimed');
          const service = Number(await readFile(join(root, 'service.pid'), 'utf8'));
          assert.equal(alive(service), true, 'A service descendant must survive controller/CLI cleanup');
          if (scenario === 'hang') assert.equal(result.recovery.ok, true, 'Runner is usable after timeout');
        }
        t.diagnostic(JSON.stringify({ scenario, elapsedMs: result.elapsedMs, bounded: true,
          servicePreserved: scenario !== 'success', recovery: result.recovery?.ok ?? null }));
      } finally { await cleanup(); }
    });
  }

  async function cleanup() {
    for (const name of ['controller', 'cli', 'service']) {
      const path = join(root, name + '.pid');
      if (!existsSync(path)) continue;
      const pid = Number(await readFile(path, 'utf8'));
      const observed = await inspectWindowsNativeProcess(pid);
      if (!observed) continue;
      assert.equal(observed.executable.toLowerCase(), node.toLowerCase());
      assert.ok(observed.commandLine.includes(root));
      await stopWindowsNativeProcess(pid, { pid, command: observed.executable, ownership: observed });
      assert.equal(alive(pid), false, name + ' fixture cleanup confirmed');
    }
  }
});

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function run(command, args) {
  return new Promise((resolveRun, reject) => execFile(command, args, {
    windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024
  }, (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolveRun(stdout)));
}
