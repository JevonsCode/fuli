import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareSemanticVersions,
  resolveGlobalCliPath,
  runUpdateCommand
} from '../src/cli/update-command.js';
import { FULI_VERSION } from '../src/package-metadata.js';

test('update cancellation has no side effects', async () => {
  const output = [];
  let stopped = false;
  let spawned = false;
  const result = await runUpdateCommand([], {
    confirm: async () => false,
    stopRuntime: async () => {
      stopped = true;
      return { status: 'stopped' };
    },
    runInherited: () => {
      spawned = true;
      return { status: 0 };
    },
    write: (line) => output.push(line)
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  assert.match(output[0], /fuli-context@latest/);
  assert.match(output.at(-1), /No changes were made/);
});

test('update installs latest globally and runs setup from the newly installed package',
  async () => {
    const calls = [];
    const output = [];
    const args = [
      '--yes',
      '--data-dir', 'D:/Fuli Data',
      '--port', '3199',
      '--no-start'
    ];
    const result = await runUpdateCommand(args, {
      platform: 'linux',
      nodePath: '/usr/local/bin/node',
      npmCommand: 'npm',
      stopRuntime: async (command, commandArgs) => {
        calls.push({ kind: 'stop', command, args: commandArgs });
        return { status: 'stopped' };
      },
      runInherited: (command, commandArgs) => {
        calls.push({ kind: 'inherited', command, args: commandArgs });
        return { status: 0 };
      },
      runCaptured: (command, commandArgs) => {
        calls.push({ kind: 'captured', command, args: commandArgs });
        if (command !== 'npm') return { status: 0, stdout: '9.8.7\n' };
        return commandArgs[0] === 'view'
          ? { status: 0, stdout: '"9.8.7"\n' }
          : { status: 0, stdout: '/opt/npm/lib/node_modules\n' };
      },
      fileExists: (path) => {
        calls.push({ kind: 'exists', path });
        return true;
      },
      confirm: async () => {
        assert.fail('--yes must skip confirmation');
      },
      write: (line) => output.push(line)
    });

    const cliPath = '/opt/npm/lib/node_modules/fuli-context/src/cli.js';
    assert.deepEqual(calls, [
      {
        kind: 'captured',
        command: 'npm',
        args: ['view', 'fuli-context@latest', 'version', '--json']
      },
      { kind: 'stop', command: 'stop', args: ['--data-dir', 'D:/Fuli Data'] },
      {
        kind: 'inherited',
        command: 'npm',
        args: [
          'install',
          '--global',
          'fuli-context@9.8.7',
          '--no-audit',
          '--no-fund'
        ]
      },
      { kind: 'captured', command: 'npm', args: ['root', '--global'] },
      { kind: 'exists', path: cliPath },
      {
        kind: 'captured',
        command: '/usr/local/bin/node',
        args: [cliPath, '--version']
      },
      {
        kind: 'inherited',
        command: '/usr/local/bin/node',
        args: [
          cliPath,
          'setup',
          '--yes',
          '--data-dir', 'D:/Fuli Data',
          '--port', '3199',
          '--no-start'
        ]
      }
    ]);
    assert.deepEqual(result, {
      status: 'updated',
      previousVersion: FULI_VERSION,
      version: '9.8.7'
    });
    assert.match(output.join('\n'), /refresh through setup in the new version/);
    assert.match(output.at(-1), /9\.8\.7/);
    assert.doesNotMatch(output.join('\n'), /[\p{Script=Han}]/u);
  });

test('update aborts before npm when the old console identity cannot be verified',
  async () => {
    let spawned = false;
    await assert.rejects(
      runUpdateCommand(['--yes'], {
        stopRuntime: async () => ({ status: 'partial' }),
      runInherited: () => {
        spawned = true;
        return { status: 0 };
      },
      resolveLatestVersion: () => FULI_VERSION,
      write: () => {}
      }),
      /update did not start/
    );
    assert.equal(spawned, false);
  });

test('update reports a manual recovery path when npm installation fails', async () => {
  await assert.rejects(
    runUpdateCommand(['--yes'], {
      stopRuntime: async () => ({ status: 'stopped' }),
      runInherited: () => ({ status: 1 }),
      resolveLatestVersion: () => FULI_VERSION,
      write: () => {}
    }),
    /npm install --global fuli-context@latest/
  );
});

test('update preserves setup flags in the recovery command after installation', async () => {
  let inheritedCalls = 0;
  await assert.rejects(
    runUpdateCommand([
      '--yes',
      '--data-dir', 'D:/Fuli Data',
      '--no-start'
    ], {
      platform: 'linux',
      nodePath: '/usr/bin/node',
      stopRuntime: async () => ({ status: 'stopped' }),
      resolveLatestVersion: () => '1.2.3',
      runInherited: () => {
        inheritedCalls += 1;
        return { status: inheritedCalls === 1 ? 0 : 2 };
      },
      runCaptured: (command) => command === 'npm'
        ? { status: 0, stdout: '/usr/lib/node_modules\n' }
        : { status: 0, stdout: '1.2.3\n' },
      fileExists: () => true,
      write: () => {}
    }),
    /fuli setup --yes --data-dir 'D:\/Fuli Data' --no-start/
  );
});

test('Windows recovery output preserves backslashes in a quoted data path', async () => {
  let inheritedCalls = 0;
  await assert.rejects(
    runUpdateCommand(['--yes', '--data-dir', 'C:\\Fuli Data'], {
      platform: 'win32',
      nodePath: 'C:\\Node\\node.exe',
      npmCommand: 'npm.cmd',
      stopRuntime: async () => ({ status: 'stopped' }),
      resolveLatestVersion: () => '1.2.3',
      runInherited: () => {
        inheritedCalls += 1;
        return { status: inheritedCalls === 1 ? 0 : 2 };
      },
      runCaptured: (command) => command === 'npm.cmd'
        ? { status: 0, stdout: 'C:\\npm\\node_modules\n' }
        : { status: 0, stdout: '1.2.3\n' },
      fileExists: () => true,
      write: () => {}
    }),
    (error) => {
      assert.ok(error.message.includes(
        'fuli setup --yes --data-dir "C:\\Fuli Data"'
      ));
      return true;
    }
  );
});

test('update reports current when npm latest matches the running version', async () => {
  const result = await runUpdateCommand(['--yes', '--skip-agents'], {
    platform: 'linux',
    stopRuntime: async () => ({ status: 'stopped' }),
    resolveLatestVersion: () => FULI_VERSION,
    runInherited: () => ({ status: 0 }),
    runCaptured: (command) => command === 'npm'
      ? { status: 0, stdout: '/usr/lib/node_modules\n' }
      : { status: 0, stdout: `${FULI_VERSION}\n` },
    fileExists: () => true,
    write: () => {}
  });

  assert.equal(result.status, 'current');
  assert.equal(result.version, FULI_VERSION);
});

test('update refuses to downgrade a workspace CLI newer than npm latest', async () => {
  let stopped = false;
  let spawned = false;
  const output = [];
  const result = await runUpdateCommand(['--yes'], {
    resolveLatestVersion: () => '0.2.0',
    stopRuntime: async () => {
      stopped = true;
      return { status: 'stopped' };
    },
    runInherited: () => {
      spawned = true;
      return { status: 0 };
    },
    write: (line) => output.push(line)
  });

  assert.deepEqual(result, {
    status: 'ahead',
    previousVersion: FULI_VERSION,
    version: FULI_VERSION,
    latestVersion: '0.2.0'
  });
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  assert.match(output.at(-1), /avoid a downgrade/);
});

test('update checks npm latest before stopping the local service', async () => {
  let stopped = false;
  await assert.rejects(
    runUpdateCommand(['--yes'], {
      runCaptured: () => ({ status: 1 }),
      stopRuntime: async () => {
        stopped = true;
        return { status: 'stopped' };
      },
      write: () => {}
    }),
    /Local services were not stopped/
  );
  assert.equal(stopped, false);
});

test('semantic version comparison handles releases and prereleases', () => {
  assert.equal(compareSemanticVersions('0.3.0', '0.2.0'), 1);
  assert.equal(compareSemanticVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareSemanticVersions('0.3.0-beta.2', '0.3.0-beta.11'), -1);
  assert.equal(compareSemanticVersions('0.3.0', '0.3.0-rc.1'), 1);
  assert.throws(() => compareSemanticVersions('latest', '0.3.0'), /Invalid package version/);
});

test('global CLI resolution supports POSIX and Windows npm roots', () => {
  assert.equal(
    resolveGlobalCliPath('/usr/local/lib/node_modules', 'linux'),
    '/usr/local/lib/node_modules/fuli-context/src/cli.js'
  );
  assert.equal(
    resolveGlobalCliPath('C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules', 'win32'),
    'C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\fuli-context\\src\\cli.js'
  );
  assert.equal(resolveGlobalCliPath('relative/node_modules', 'linux'), null);
});
