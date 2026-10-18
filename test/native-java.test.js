import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNativeJavaHome } from '../src/native-runtime/java-runtime.js';
const output = (version = '21.0.9', arch = 'aarch64') => ({ status: 0, stdout: '', stderr: `    java.home = /synthetic/jdk\n    java.version = ${version}\n    os.arch = ${arch}\n` });
test('configured JDK is executed to verify Java 21 and matching architecture', async () => {
  const calls = [];
  assert.equal(await resolveNativeJavaHome({ JAVA_HOME: '/synthetic/jdk' }, {
    platform: 'darwin', arch: 'arm64', run: async (...args) => { calls.push(args); return output(); }
  }), '/synthetic/jdk');
  assert.deepEqual(calls[0].slice(0, 2), ['/synthetic/jdk/bin/java', ['-XshowSettings:properties', '-version']]);
});
for (const [version, arch] of [['17.0.1', 'aarch64'], ['25.0.1', 'aarch64'], ['21.0.9', 'x86_64']]) {
  test(`configured incompatible Java ${version}/${arch} fails explicitly`, async () => {
    await assert.rejects(resolveNativeJavaHome({ JAVA_HOME: '/synthetic/jdk' }, {
      platform: 'darwin', arch: 'arm64', run: async () => output(version, arch)
    }), /Java 21|architecture/i);
  });
}
test('PATH Java resolves its reported absolute home instead of a relative dot', async () => {
  assert.equal(await resolveNativeJavaHome({}, {
    platform: 'linux', arch: 'x64', run: async () => output('21.0.9', 'amd64')
  }), '/synthetic/jdk');
});
test('unsupported host architecture is rejected before invoking a command', async () => {
  await assert.rejects(resolveNativeJavaHome({}, { platform: 'darwin', arch: 'riscv64', run: async () => assert.fail() }), /architecture/i);
});
