import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the setup CLI forwards a partial setup exit code to its parent process', () => {
  const hook = `import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith('/cli/setup-command.js')) return { format: 'module', shortCircuit: true,
        source: 'export async function runSetupCommand() { return { status: "partial", exitCode: 1 }; }' };
      return nextLoad(url, context);
    } });`;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(hook)}`,
    fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'setup', '--yes'
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
});
