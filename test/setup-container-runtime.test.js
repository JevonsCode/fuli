import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containerRuntimeError,
  ensureContainerRuntime,
  inspectContainerRuntime,
  runDockerCompose
} from '../src/setup/container-runtime.js';

test('container runtime inspection accepts Docker Compose with a healthy daemon', () => {
  const calls = [];
  const runtime = inspectContainerRuntime({
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    homeDir: '/home/example',
    pathExists: () => false,
    run(command, args, env) {
      calls.push({ command, args, env });
      if (args[0] === '--version') return succeeded('Docker version 27');
      if (args[0] === 'compose') return succeeded('Docker Compose version v2.30');
      if (args[0] === 'info') return succeeded('27.0.1');
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    }
  });

  assert.equal(runtime.status, 'ready');
  assert.equal(runtime.dockerCommand, 'docker');
  assert.equal(calls.some(({ args }) => args[0] === 'compose'), true);
});

test('container runtime inspection reports a missing runtime before setup writes data', () => {
  const runtime = inspectContainerRuntime({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    homeDir: '/Users/example',
    pathExists: () => false,
    run: () => failed('command not found')
  });

  assert.equal(runtime.status, 'missing');
  assert.match(containerRuntimeError(runtime, 'darwin').message, /Rancher Desktop/);
  assert.match(containerRuntimeError(runtime, 'darwin').message, /重新运行 fl setup/);
});

test('macOS inspection recognizes Rancher Desktop and its user-scoped Docker socket', () => {
  const existing = new Set([
    '/Applications/Rancher Desktop.app',
    '/Users/example/.rd/bin/docker',
    '/Users/example/.rd/bin/rdctl',
    '/Users/example/.rd/docker.sock'
  ]);
  const runtime = inspectContainerRuntime({
    env: { PATH: '/usr/bin' },
    platform: 'darwin',
    homeDir: '/Users/example',
    pathExists: (path) => existing.has(path),
    run(command, args) {
      if (args[0] === '--version' && command.endsWith('/.rd/bin/docker')) {
        return succeeded('Docker version 27');
      }
      if (args[0] === 'compose') return succeeded('Docker Compose version v2.30');
      if (args[0] === 'info') return failed('connection refused');
      return failed('command not found');
    }
  });

  assert.equal(runtime.status, 'stopped');
  assert.equal(runtime.desktop.label, 'Rancher Desktop');
  assert.equal(runtime.desktop.launchCommand, '/Users/example/.rd/bin/rdctl');
  assert.equal(runtime.dockerEnvironment.DOCKER_HOST,
    'unix:///Users/example/.rd/docker.sock');
});

test('setup launches an installed desktop runtime and waits until Docker is ready', async () => {
  const progress = [];
  const launched = [];
  let inspections = 0;
  const stopped = {
    status: 'stopped',
    label: 'Rancher Desktop',
    desktop: {
      id: 'rancher-desktop',
      label: 'Rancher Desktop',
      launchCommand: '/Users/example/.rd/bin/rdctl',
      launchArgs: ['start']
    }
  };
  const ready = {
    status: 'ready',
    label: 'Rancher Desktop',
    dockerCommand: 'docker',
    dockerEnvironment: {}
  };

  const result = await ensureContainerRuntime({
    onProgress: (message) => progress.push(message),
    pollIntervalMs: 1,
    maxWaitMs: 3
  }, {
    inspect() {
      inspections += 1;
      return inspections < 3 ? stopped : ready;
    },
    async launch(desktop) {
      launched.push(desktop.id);
    },
    async wait() {}
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(launched, ['rancher-desktop']);
  assert.equal(progress.length, 1);
  assert.match(progress[0], /正在启动 Rancher Desktop/);
});

test('an explicit unavailable Docker target is never replaced by a local desktop runtime',
  async () => {
    let launched = false;
    await assert.rejects(
      ensureContainerRuntime({}, {
        inspect: () => ({
          status: 'unavailable',
          label: 'Docker',
          desktop: null,
          explicitTarget: true,
          detail: 'connection refused'
        }),
        async launch() {
          launched = true;
        }
      }),
      /DOCKER_HOST 或 DOCKER_CONTEXT/
    );
    assert.equal(launched, false);
  });

test('missing runtime guidance accounts for the Windows WSL prerequisite', () => {
  const error = containerRuntimeError({ status: 'missing' }, 'win32');
  assert.match(error.message, /WSL 2/);
  assert.match(error.message, /Rancher Desktop/);
});

test('Compose failures preserve useful diagnostics while redacting local and secret values', () => {
  const runtime = {
    status: 'ready',
    dockerCommand: 'docker',
    dockerEnvironment: { PATH: '/usr/bin' }
  };
  let error = null;
  try {
    runDockerCompose(['compose', 'up'], runtime, {
      platform: 'darwin',
      homeDir: '/Users/example',
      run: () => failed(
        'Bind for 127.0.0.1:8787 failed: port is already allocated\n' +
        'config=/Users/example/Fuli password=do-not-print'
      )
    });
  } catch (caught) {
    error = caught;
  }

  assert.match(error.message, /本地端口已被占用/);
  assert.match(error.message, /~\/Fuli/);
  assert.doesNotMatch(error.message, /do-not-print/);
  assert.match(error.message, /password=\[redacted\]/);
});

test('Compose reports a daemon disconnect instead of a generic provider error', () => {
  const runtime = {
    status: 'ready',
    dockerCommand: 'docker',
    dockerEnvironment: {}
  };

  assert.throws(
    () => runDockerCompose(['compose', 'up'], runtime, {
      run: () => failed('error during connect: unexpected EOF')
    }),
    /容器运行时在启动 Fuli Provider 时失去连接/
  );
});

function succeeded(stdout = '') {
  return { status: 0, stdout, stderr: '' };
}

function failed(stderr = '') {
  return { status: 1, stdout: '', stderr };
}
