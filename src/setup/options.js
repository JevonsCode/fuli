const VALUE_OPTIONS = Object.freeze({
  '--data-dir': 'dataDir',
  '--personal-space': 'personalSpaceName',
  '--port': 'port'
});

const BOOLEAN_OPTIONS = Object.freeze({
  '--yes': 'yes',
  '--skip-agents': 'skipAgents',
  '--no-start': 'noStart'
});

export function parseSetupOptions(args = []) {
  const result = {
    dataDir: null,
    personalSpaceName: '我',
    port: 5173,
    yes: false,
    skipAgents: false,
    noStart: false
  };
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new TypeError(`Duplicate ${flag}`);
    const booleanKey = BOOLEAN_OPTIONS[flag];
    if (booleanKey) {
      result[booleanKey] = true;
      seen.add(flag);
      continue;
    }
    const valueKey = VALUE_OPTIONS[flag];
    if (!valueKey) throw new TypeError(`Unknown setup option: ${flag}`);
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

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('--port must be between 1 and 65535');
  }
  return port;
}
