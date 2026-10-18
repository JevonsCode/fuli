import { execFile } from 'node:child_process';
import { posix } from 'node:path';

// Only macOS and Linux resolve a system JDK; Windows uses the bundled runtime.
const { isAbsolute, join } = posix;

export async function resolveNativeJavaHome(env, {
  platform = process.platform, arch = process.arch, run = commandResult
} = {}) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported native Neo4j host architecture.');
  const configured = nonEmpty(env.FULI_NATIVE_JAVA_HOME) ?? nonEmpty(env.JAVA_HOME);
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('Java 21 home must be an absolute path.');
    const home = await verifiedHome(join(configured, 'bin', 'java'));
    if (!home) throw new Error('Configured native Java must be Java 21 with the matching host architecture.');
    return home;
  }
  if (platform === 'darwin') {
    for (const [command, args] of [['/usr/libexec/java_home', ['-v', '21']], ['brew', ['--prefix', 'openjdk@21']]]) {
      const found = await run(command, args, { env });
      const candidate = nonEmpty(found.stdout);
      if (found.status === 0 && candidate && isAbsolute(candidate)) {
        const home = await verifiedHome(join(candidate, 'bin', 'java'));
        if (home) return home;
      }
    }
  }
  return verifiedHome('java');

  async function verifiedHome(command) {
    const result = await run(command, ['-XshowSettings:properties', '-version'], { env });
    if (result.status !== 0) return null;
    const text = `${result.stdout}\n${result.stderr}`;
    const property = name => nonEmpty(new RegExp(`^\\s*${name.replaceAll('.', '\\.')}\\s*=\\s*(.+)$`, 'm').exec(text)?.[1]);
    const version = property('java.version'), javaArch = property('os.arch'), home = property('java.home');
    if (!/^21(?:\.|$)/.test(version ?? '') || !home || !isAbsolute(home)) return null;
    const compatible = arch === 'arm64' ? ['aarch64', 'arm64'] : ['amd64', 'x86_64', 'x64'];
    return compatible.includes(javaArch) ? home : null;
  }
}

function nonEmpty(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function commandResult(command, args, { env }) {
  return new Promise(resolve => execFile(command, args, {
    env, timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true
  }, (error, stdout, stderr) => resolve({ status: error ? 1 : 0, stdout, stderr })));
}
