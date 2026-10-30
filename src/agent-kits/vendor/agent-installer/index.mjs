import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

/** Default and largest accepted `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;

/**
 * The per-user directory of hand-written client files shared by every host,
 * or undefined when the environment does not name a home directory:
 * `agent-clients/extensions` under `%APPDATA%` on Windows, and under
 * `$XDG_CONFIG_HOME` (when absolute) or `~/.config` elsewhere. While it does
 * not exist, a directory left at the old location
 * (`agent-session-launcher/clients`) is returned instead; files are never
 * moved. Shared with agent-session-launcher, whose binding resolves the same
 * path.
 */
export function defaultExtensionsDirectory(env = process.env, platform = process.platform) {
  const root = sharedBase(env, platform);
  if (root === undefined) return undefined;
  const path = platform === 'win32' ? win32 : posix;
  const current = path.join(root, 'agent-clients', 'extensions');
  const legacy = path.join(root, 'agent-session-launcher', 'clients');
  return !isDirectory(current) && isDirectory(legacy) ? legacy : current;
}

/** Where originals are copied before `product` changes a client: `agent-clients/backups/<product>`. */
export function defaultBackupsDirectory(product, env = process.env, platform = process.platform) {
  const root = sharedBase(env, platform);
  if (root === undefined) return undefined;
  return (platform === 'win32' ? win32 : posix).join(root, 'agent-clients', 'backups', product);
}

function sharedBase(env, platform) {
  if (platform === 'win32') return env.APPDATA || undefined;
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && xdg.startsWith('/') ? xdg : env.HOME ? posix.join(env.HOME, '.config') : undefined;
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * Bind the native `agent-installer` executable and a product manifest once,
 * then call `scan`, `status`, `plan`, `apply` and `remove`. Every failure
 * rejects with an Error whose `code` is the installer or binding error code;
 * nothing throws synchronously. `apply` and `remove` change files: call them
 * only after the person chose the clients, and never retry them
 * automatically after `unknown_outcome`; check `status` first.
 */
export function createInstaller({
  executable, manifestPath, variables = {}, extensionsDir, backupsDir, timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let invalid;
  try {
    for (const [name, path] of [['executable', executable], ['manifestPath', manifestPath]]) {
      if (typeof path !== 'string' || !isAbsolute(path)) {
        throw bindingError('invalid_arguments', `${name} must be an absolute path.`);
      }
    }
    for (const [name, path] of [['extensionsDir', extensionsDir], ['backupsDir', backupsDir]]) {
      if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path))) {
        throw bindingError('invalid_arguments', `${name} must be an absolute path.`);
      }
    }
    if (variables === null || typeof variables !== 'object'
      || Object.values(variables).some(value => typeof value !== 'string')) {
      throw bindingError('invalid_arguments', 'variables must map names to text.');
    }
    checkTimeout(timeoutMs, MAX_TIMEOUT_MS);
  } catch (error) {
    invalid = error;
  }
  const common = [
    ...(extensionsDir === undefined ? [] : ['--extensions', extensionsDir]),
    '--json',
  ];
  const product = [
    '--product', manifestPath,
    ...Object.entries(variables ?? {}).flatMap(([key, value]) => ['--var', `${key}=${value}`]),
    ...(backupsDir === undefined ? [] : ['--backups', backupsDir]),
  ];
  const clientArgs = clients => {
    if (!Array.isArray(clients) || clients.length === 0 || clients.some(c => typeof c !== 'string')) {
      throw bindingError('invalid_arguments', 'Select at least one client ID.');
    }
    return ['--clients', clients.join(',')];
  };
  const call = async args => {
    if (invalid) throw invalid;
    const { exitCode, response } = await runNative(executable, [...args, ...common], { timeoutMs, maxBytes: MAX_BYTES });
    if (!response.ok) {
      throw bindingError(response.error?.code ?? 'invalid_response', response.error?.message ?? 'The installer failed.');
    }
    // 0: done; 2: done, but some components were left alone.
    if (exitCode !== 0 && exitCode !== 2) {
      throw bindingError('invalid_response', 'The executable returned an invalid response.');
    }
    return { exitCode, response };
  };
  const results = async args => {
    const { exitCode, response } = await call(args);
    return {
      clients: response.clients,
      partial: exitCode === 2,
      problems: response.clients.flatMap(c => c.problems.map(message => ({ client: c.id, message }))),
      extensionErrors: response.extensionErrors,
    };
  };
  return {
    scan: async () => {
      const { clients, extensionErrors } = (await call(['scan'])).response;
      return { clients, extensionErrors };
    },
    status: async clients => {
      const { clients: states, extensionErrors } = (await call([
        'status', ...product, ...(clients === undefined ? [] : clientArgs(clients)),
      ])).response;
      return { clients: states, extensionErrors };
    },
    plan: async clients => results(['plan', ...product, ...clientArgs(clients)]),
    apply: async clients => results(['apply', ...product, ...clientArgs(clients)]),
    remove: async clients => results(['remove', ...product, ...clientArgs(clients)]),
  };
}

/**
 * Runs the native executable once and reads its single JSON response.
 * The same helper is copied in agent-session-launcher's binding; keep them in step.
 * Resolves { exitCode, response }. Rejects with an Error carrying `code`:
 *   unavailable       the executable could not start
 *   unknown_outcome   no answer within timeoutMs; the process was killed and the
 *                     action may or may not have happened, so never retry automatically
 *   invalid_response  the output was not one bounded version-1 JSON object
 */
function runNative(executable, args, { input, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    let bytes = 0;
    let done = false;
    const timer = setTimeout(() => finish(bindingError('unknown_outcome',
      `No answer within ${timeoutMs} ms; the outcome is unknown, so do not retry automatically.`), true), timeoutMs);
    function finish(error, kill = false, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (kill) child.kill();
      if (error) reject(error); else resolve(value);
    }
    child.on('error', () => finish(bindingError('unavailable', 'The executable could not start.')));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) finish(bindingError('invalid_response', 'The response is too large.'), true);
      else chunks.push(chunk);
    });
    child.on('close', exitCode => {
      if (done) return;
      let response;
      try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(bindingError('invalid_response', 'The executable did not return JSON.')); }
      if (!response || response.version !== 1 || typeof response.ok !== 'boolean') {
        return finish(bindingError('invalid_response', 'The executable returned an invalid response.'));
      }
      finish(null, false, { exitCode, response });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function checkTimeout(timeoutMs, max) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > max) {
    throw bindingError('invalid_timeout', `The timeout must be between 1 and ${max} ms.`);
  }
}

function bindingError(code, message) {
  return Object.assign(new Error(message), { code });
}
