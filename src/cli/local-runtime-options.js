import { DEFAULT_FULI_PORT } from '../defaults.js';

const VALUE_OPTIONS = Object.freeze({
  '--data-dir': 'dataDir',
  '--personal-space': 'personalSpaceName',
  '--port': 'port'
});

const BOOLEAN_OPTIONS = Object.freeze({
  '--open': 'open',
  '--rebuild': 'rebuild',
  '--lan': 'lan',
  '--json': 'json'
});

const ALLOWED_BY_COMMAND = Object.freeze({
  start: new Set(['--data-dir', '--personal-space', '--port', '--open', '--rebuild', '--lan']),
  stop: new Set(['--data-dir']),
  restart: new Set([
    '--data-dir', '--personal-space', '--port', '--open', '--rebuild', '--lan'
  ]),
  status: new Set(['--data-dir', '--port', '--json']),
  open: new Set(['--data-dir'])
});

export function parseLocalRuntimeOptions(command, args = []) {
  const allowed = ALLOWED_BY_COMMAND[command];
  if (!allowed) throw new TypeError(`Unknown local runtime command: ${command}`);
  const result = {
    dataDir: null,
    personalSpaceName: '我',
    port: DEFAULT_FULI_PORT,
    open: false,
    rebuild: false,
    lan: false,
    json: false
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new TypeError(`Unknown ${command} option: ${flag}`);
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    seen.add(flag);

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
    result[valueKey] = valueKey === 'port' ? parsePort(value) : value.trim();
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
