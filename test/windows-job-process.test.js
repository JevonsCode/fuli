import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnWindowsJobProcess } from '../src/native-runtime/windows-job-process.js';

// rec#33: with the ACP host's isolated home PowerShell has no module analysis
// cache, so a helper that auto-loads its cmdlets scans every module on the
// machine's PSModulePath at each launch. A synthetic module that claims the
// helper's cmdlets makes that discovery observable without timing: a helper that
// consults PSModulePath resolves the decoy and fails to start.
test('the owned job helper uses only its built-in cmdlets and never discovers PSModulePath modules', {
  skip: process.platform !== 'win32'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-job-helper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, 'modules');
  for (const command of ['ConvertFrom-Json', 'Add-Type']) {
    const name = 'FuliDecoy' + command.replace('-', '');
    await mkdir(join(modules, name), { recursive: true });
    await writeFile(join(modules, name, name + '.psm1'), `function ${command} { throw 'decoy ${command}' }`);
    await writeFile(join(modules, name, name + '.psd1'), `@{ RootModule='${name}.psm1'; ModuleVersion='1.0';`
      + ` GUID='${randomUUID()}'; FunctionsToExport=@('${command}') }`);
  }
  const env = { ...process.env, PSModulePath: modules, LOCALAPPDATA: join(root, 'local'), APPDATA: join(root, 'roaming') };
  const child = await spawnWindowsJobProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: root, env, stopTimeoutMs: 8000 });
  const ready = await child.ready;
  assert.ok(Number.isInteger(ready.pid) && ready.pid > 0);
  assert.deepEqual(await child.exited, { clean: true });
});
