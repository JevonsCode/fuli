import { DEFAULT_FULI_PORT } from '../defaults.js';

const VALUE_OPTIONS = Object.freeze({
  '--data-dir': 'dataDir',
  '--personal-space': 'personalSpaceName',
  '--port': 'port'
});

const BOOLEAN_OPTIONS = Object.freeze({
  '--yes': 'yes',
  '--codex-only': 'codexOnly',
  '--skip-agents': 'skipAgents',
  '--no-start': 'noStart'
});

const PROVIDER_MODE_OPTIONS = new Set(['--personal-only', '--with-dev-public']);

export function parseSetupOptions(args = []) {
  return parseSetupLikeOptions(args, 'setup');
}

export function parseUpdateOptions(args = []) {
  return parseSetupLikeOptions(args, 'update');
}

function parseSetupLikeOptions(args, command) {
  const result = {
    dataDir: null,
    personalSpaceName: '我',
    port: DEFAULT_FULI_PORT,
    yes: false,
    codexOnly: false,
    skipAgents: false,
    personalOnly: true,
    noStart: false
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    if (PROVIDER_MODE_OPTIONS.has(flag)) {
      const conflicting = flag === '--personal-only' ? '--with-dev-public' : '--personal-only';
      if (seen.has(conflicting)) {
        throw new TypeError('--personal-only and --with-dev-public cannot be combined');
      }
      result.personalOnly = flag !== '--with-dev-public';
      seen.add(flag);
      continue;
    }
    const booleanKey = BOOLEAN_OPTIONS[flag];
    if (booleanKey) {
      result[booleanKey] = true;
      seen.add(flag);
      continue;
    }
    const valueKey = VALUE_OPTIONS[flag];
    if (!valueKey) throw new TypeError(`Unknown ${command} option: ${flag}`);
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    result[valueKey] = valueKey === 'port' ? parsePort(value) : value.trim();
    seen.add(flag);
    index += 1;
  }
  return result;
}

export function parseUninstallOptions(args = []) {
  const result = { dataDir: null, yes: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    if (flag === '--yes') {
      result.yes = true;
      seen.add(flag);
      continue;
    }
    if (flag !== '--data-dir') throw new TypeError(`Unknown uninstall option: ${flag}`);
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError('Missing value for --data-dir');
    }
    result.dataDir = value.trim();
    seen.add(flag);
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
