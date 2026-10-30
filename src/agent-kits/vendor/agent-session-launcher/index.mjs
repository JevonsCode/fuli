import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, posix, win32 } from 'node:path';

const MAX_BYTES = 65536;

/**
 * The per-user directory of hand-written client files shared by every host,
 * or undefined when the environment does not name a home directory:
 * `agent-clients/extensions` under `%APPDATA%` on Windows, and under
 * `$XDG_CONFIG_HOME` (when absolute) or `~/.config` elsewhere. While it does
 * not exist, a directory left at the 0.3 location
 * (`agent-session-launcher/clients`) is returned instead; files are never
 * moved. Shared with agent-installer, whose binding resolves the same path.
 */
export function defaultExtensionsDirectory(env = process.env, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix;
  const xdg = env.XDG_CONFIG_HOME;
  const base = platform === 'win32'
    ? env.APPDATA || undefined
    : xdg && xdg.startsWith('/') ? xdg : env.HOME ? posix.join(env.HOME, '.config') : undefined;
  if (base === undefined) return undefined;
  const current = path.join(base, 'agent-clients', 'extensions');
  const legacy = path.join(base, 'agent-session-launcher', 'clients');
  return !isDirectory(current) && isDirectory(legacy) ? legacy : current;
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Default and largest accepted `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 60000;

/**
 * Bind the native executable, a trusted config file and the user's extension
 * directory once, then call `classify`, `clients`, `inspect` and `open`.
 * Every failure rejects with an Error whose `code` is the launcher or binding
 * error code; nothing throws synchronously.
 */
export function createLauncher({ executable, configPath, extensionsDir, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const options = { configPath, extensionsDir, timeoutMs };
  async function call(request) {
    const result = await requestLauncher(executable, { version: 1, ...request }, options);
    if (!result.ok) throw bindingError(result.error.code, result.error.message);
    return result;
  }
  return {
    classify: async (source, { claudeEntrypoint } = {}) => (await call({
      action: 'classify', source, ...(claudeEntrypoint === undefined ? {} : { claudeEntrypoint }),
    })).client,
    clients: async () => {
      const { clients, extensionErrors } = await call({ action: 'clients' });
      return { clients, extensionErrors };
    },
    inspect: async target => {
      const { plan, openSupported } = await call({ action: 'inspect', target });
      return { plan, openSupported };
    },
    /** Only for an explicit user action. Never retry automatically on `unknown_outcome`. */
    open: async (target, preferences) => (await call({
      action: 'open', target, ...(preferences === undefined ? {} : { preferences }),
    })).status,
  };
}

/**
 * Call the bundled native executable with one request and resolve its response,
 * including `ok: false` responses. The caller authorizes `open`; no shell is used.
 */
export async function requestLauncher(executable, request, {
  timeoutMs = DEFAULT_TIMEOUT_MS, configPath, extensionsDir,
} = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw bindingError('invalid_executable', 'The launcher executable path must be absolute.');
  }
  checkTimeout(timeoutMs, MAX_TIMEOUT_MS);
  if (configPath !== undefined && (typeof configPath !== 'string' || !isAbsolute(configPath))) {
    throw bindingError('invalid_configuration', 'The trusted configuration path must be absolute.');
  }
  if (extensionsDir !== undefined && (typeof extensionsDir !== 'string' || !isAbsolute(extensionsDir))) {
    throw bindingError('invalid_configuration', 'The extensions directory path must be absolute.');
  }
  let input;
  try { input = JSON.stringify(request); } catch { throw bindingError('invalid_request', 'The request is not JSON.'); }
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BYTES) {
    throw bindingError('invalid_request', 'The request is too large or is not JSON.');
  }
  const args = [
    ...(configPath === undefined ? [] : ['--config', configPath]),
    ...(extensionsDir === undefined ? [] : ['--extensions', extensionsDir]),
  ];
  const { exitCode, response } = await runNative(executable, args, { input, timeoutMs, maxBytes: MAX_BYTES });
  // The launcher exits non-zero exactly when `ok` is false.
  if (exitCode !== 0 && response.ok) {
    throw bindingError('invalid_response', 'The executable returned an invalid response.');
  }
  return response;
}

/**
 * Runs the native executable once and reads its single JSON response.
 * The same helper is copied in agent-installer's binding; keep them in step.
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
