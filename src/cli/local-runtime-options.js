import { consoleNextPath } from '../console-session/next-path.js';

const VALUE_OPTIONS = Object.freeze({
  '--data-dir': 'dataDir',
  '--next': 'next',
  '--personal-space': 'personalSpaceName',
  '--port': 'port'
});

const BOOLEAN_OPTIONS = Object.freeze({
  '--open': 'open',
  '--rebuild': 'rebuild',
  '--json': 'json',
  '--allow-provider-downgrade': 'allowProviderDowngrade'
});

const ALLOWED_BY_COMMAND = Object.freeze({
  start: new Set([
    '--data-dir', '--personal-space', '--port', '--open', '--rebuild', '--lan', '--no-lan', '--allow-provider-downgrade'
  ]),
  stop: new Set(['--data-dir']),
  restart: new Set([
    '--data-dir', '--personal-space', '--port', '--open', '--rebuild', '--lan', '--no-lan'
  ]),
  status: new Set(['--data-dir', '--port', '--json']),
  open: new Set(['--data-dir', '--next'])
});

export function parseLocalRuntimeOptions(command, args = []) {
  const allowed = ALLOWED_BY_COMMAND[command];
  if (!allowed) throw new TypeError(`Unknown local runtime command: ${command}`);
  const result = {
    dataDir: null,
    personalSpaceName: 'Personal',
    port: null,
    open: false,
    next: null,
    rebuild: false,
    lan: null,
    json: false,
    allowProviderDowngrade: false
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new TypeError(`Unknown ${command} option: ${flag}`);
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    seen.add(flag);

    if (flag === '--lan' || flag === '--no-lan') {
      const conflicting = flag === '--lan' ? '--no-lan' : '--lan';
      if (seen.has(conflicting)) throw new TypeError('--lan and --no-lan cannot be combined');
      result.lan = flag === '--lan';
      continue;
    }

    const booleanKey = BOOLEAN_OPTIONS[flag];
    if (booleanKey) {
      result[booleanKey] = true;
      continue;
    }
    const valueKey = VALUE_OPTIONS[flag];
    const value = args[index + 1];
    if (!valueKey || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    result[valueKey] = valueKey === 'port' ? parsePort(value) : valueKey === 'next' ? consoleNextPath(value.trim()) : value.trim();
    index += 1;
  }
  return result;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('--port must be between 1 and 65535');
  }
  return port;
}
