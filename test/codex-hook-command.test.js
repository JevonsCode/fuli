import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { parse } from 'smol-toml';

import { withCodexLifecycleHooks, withCodexTomlLifecycleHooks } from '../src/agents/codex/lifecycle-hooks.js';

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`Codex Windows commands preserve literal paths and argv in ${shell}`, { skip: process.platform !== 'win32' }, t => {
    const version = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (shell === 'pwsh.exe' && version.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
    assert.equal(version.status, 0, version.stderr);
    t.diagnostic(`${shell}: ${version.stdout.trim()}`);
    const root = mkdtempSync(join(tmpdir(), 'fuli-codex-command-'));
    const aliases = [];
    t.after(() => {
      for (const alias of aliases) unlinkSync(alias);
      rmSync(root, { recursive: true, force: true });
    });
    const node = realpathSync(process.execPath);
    for (const name of ['ordinary', 'with spaces', "single'quote", 'dollar$FULI_HOOK_TEST', 'back`tick', "mixed '$FULI_HOOK_TEST` space"]) {
      const directory = join(root, name);
      mkdirSync(directory);
      const alias = join(directory, 'node');
      symlinkSync(dirname(node), alias, 'junction');
      aliases.push(alias);
      const script = join(directory, 'argv.mjs');
      writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const runtimeConfigPath = join(directory, 'graph-runtime.json');
      const context = { nodePath: join(alias, basename(node)), platform: 'win32',
        codexLifecycleHookPath: script, runtimeConfigPath };
      const json = withCodexLifecycleHooks({}, { context });
      const toml = parse(withCodexTomlLifecycleHooks('', { context }));
      for (const event of ['UserPromptSubmit', 'Stop']) {
        const command = json.hooks[event][0].hooks[0].command;
        assert.equal(toml.hooks[event][0].hooks[0].command, command);
        // Only the synthetic argv script executes. No production Hook, model,
        // runtime config or client setting is opened by this command.
        const encoded = Buffer.from(`${command}\nexit $LASTEXITCODE`, 'utf16le').toString('base64');
        const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          encoding: 'utf8', timeout: 10_000
        });
        assert.equal(result.status, 0, `${shell}, ${name}, ${event}: ${result.stderr}`);
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), [
          '--fuli-lifecycle', '--runtime-config', runtimeConfigPath, '--event', event
        ], `${shell}, ${name}, ${event}`);
      }
    }
  });
}

test('Codex non-Windows commands retain their POSIX shell contract', () => {
  const context = { nodePath: '/usr/local/bin/node', platform: 'linux',
    codexLifecycleHookPath: '/tmp/argv.mjs', runtimeConfigPath: '/tmp/runtime.json' };
  const command = withCodexLifecycleHooks({}, { context }).hooks.UserPromptSubmit[0].hooks[0].command;
  assert.equal(command, "'/usr/local/bin/node' '/tmp/argv.mjs' '--fuli-lifecycle' '--runtime-config' '/tmp/runtime.json' '--event' 'UserPromptSubmit'");
});
