// The graph provider's environment file (graph-provider.env): KEY=VALUE
// lines written by setup. Blank lines and # comments are skipped.
export function parseProviderEnv(body) {
  const values = {};
  for (const line of String(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}
