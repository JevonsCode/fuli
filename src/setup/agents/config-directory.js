// Client-documented home overrides are directories, never server-supplied HTTP input.
export function configDirectory(value, fallback, { homeDir, pathApi, cwd = process.cwd() }) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const expanded = value === '~' ? homeDir
    : /^~[/\\]/.test(value) ? pathApi.join(homeDir, value.slice(2)) : value;
  return pathApi.resolve(cwd, expanded);
}
