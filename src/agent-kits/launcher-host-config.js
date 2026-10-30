// The session launcher's host configuration (agent-session-launcher
// docs/configuration.md), generated from FULI's `conversationLaunchers`
// setting. Each FULI application whose deep link the launcher can express
// becomes a host-defined URI client `fuli-<application>`; the rest are not in
// the configuration and keep FULI's own link rendering. The file is derived:
// it is rewritten from runtime-settings.json (writeDerivedJson) whenever the
// two differ.

// The launcher's deep-link template rules at v0.4.0 (lib/src/config.dart):
// scheme://host/path?key=value with plain tokens, `{id}` exactly once as a
// whole path segment or query value, no web, file or script scheme. A
// template outside them would make the launcher refuse the whole file.
const URI_TEMPLATE = /^([a-z][a-z0-9+.-]{0,31}):\/\/([a-z0-9][a-z0-9.-]{0,127})((?:\/[^/?#]*)*)(?:\?([^#]*))?$/;
const URI_TOKEN = /^[A-Za-z0-9._~-]{1,256}$/;
const BLOCKED_SCHEMES = new Set(['http', 'https', 'file', 'data', 'javascript', 'mailto']);
const MAX_QUERY_KEYS = 16;
const MAX_PATH_SEGMENTS = 32;

// conversationLaunchers: normalized runtime settings (runtime-settings.js).
// Answers the configuration and, per FULI application, the client ID that
// opens it in the launcher.
export function launcherHostConfig(conversationLaunchers) {
  const clients = {};
  const hostClients = {};
  for (const [application, rule] of Object.entries(conversationLaunchers)) {
    if (!launcherCanExpress(rule.urlTemplate)) continue;
    const id = `fuli-${application.replaceAll('_', '-')}`;
    clients[id] = {
      ...(rule.appName ? { name: rule.appName } : {}),
      enabled: rule.enabled,
      launch: { uri: rule.urlTemplate, idFormat: rule.idFormat === 'uuid' ? 'uuid' : 'safe' }
    };
    hostClients[application] = id;
  }
  return { config: { schemaVersion: 1, clients }, hostClients };
}

function launcherCanExpress(template) {
  const match = URI_TEMPLATE.exec(template ?? '');
  if (!match || BLOCKED_SCHEMES.has(match[1])) return false;
  const segments = match[3].split('/').filter(Boolean);
  const pairs = match[4] ? match[4].split('&') : [];
  const keys = new Set();
  const values = [];
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    const key = equals < 0 ? pair : pair.slice(0, equals);
    if (!URI_TOKEN.test(key) || keys.has(key)) return false;
    keys.add(key);
    values.push(equals < 0 ? '' : pair.slice(equals + 1));
  }
  const tokens = [...segments, ...values];
  return pairs.length <= MAX_QUERY_KEYS && segments.length <= MAX_PATH_SEGMENTS
    && tokens.every((token) => token === '{id}' || URI_TOKEN.test(token))
    && tokens.filter((token) => token === '{id}').length === 1;
}
