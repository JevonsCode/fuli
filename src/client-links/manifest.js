// The client link manifest (registry/client-links.json, docs/client-links.md):
// for each Agent client, the documented links that open one of its sessions.
// It is data, shared with other tools such as DingDong; nothing here knows a
// client. A manifest is accepted only whole and only when every field is
// exactly as documented, so a fetched copy can never carry a script link.

const CLIENT_LINKS_FORMAT_ID = 'fuli-client-links';
const CLIENT_LINKS_FORMAT_VERSION = 1;
// Schemes a link may use besides https: apps whose links the manifest
// documents. A new app scheme ships with FULI, never with a fetched manifest.
const CLIENT_LINK_APP_SCHEMES = Object.freeze(['codex', 'vscode', 'vscode-insiders', 'cursor', 'claude', 'claude-cli', 'kiro']);
const PLATFORMS = new Set(['macos', 'windows', 'linux', 'web']);
const PARAMETER_FORMATS = new Set(['uuid', 'any']);
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const PARAMETER = /^[a-z][A-Za-z0-9]{0,31}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const MAX_CLIENTS = 64;
const MAX_LINKS = 8;

class ClientLinksManifestError extends TypeError {
  constructor(message) {
    super(`Client link manifest: ${message}`);
    this.code = 'client_links_invalid';
  }
}

const fail = message => { throw new ClientLinksManifestError(message); };

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) fail(`${label} has unknown fields: ${extra.join(', ')}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} needs ${key}`);
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be text of at most ${max} characters`);
  }
  return value;
}

function httpsUrl(value, label) {
  text(value, label, 512);
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be an https URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(`${label} must be an https URL`);
  return value;
}

function template(link, label) {
  const value = text(link.template, `${label}.template`, 512);
  if (/\s/.test(value)) fail(`${label}.template must not contain spaces`);
  const used = [...value.matchAll(PLACEHOLDER)].map(match => match[1]);
  if (value.replace(PLACEHOLDER, '').includes('{') || value.replace(PLACEHOLDER, '').includes('}')) {
    fail(`${label}.template has an unbalanced placeholder`);
  }
  const declared = Object.keys(link.parameters);
  if (!used.length || new Set(used).size !== used.length || used.some(name => !declared.includes(name))
    || declared.some(name => !used.includes(name))) {
    fail(`${label}.template must use each declared parameter exactly once`);
  }
  let url;
  try { url = new URL(value.replace(PLACEHOLDER, 'x')); } catch { fail(`${label}.template is not a URL`); }
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== 'https' && !CLIENT_LINK_APP_SCHEMES.includes(scheme)) {
    fail(`${label}.template uses a scheme FULI does not open (${scheme})`);
  }
  if (url.username || url.password || url.hash) fail(`${label}.template must not carry credentials or a fragment`);
  return value;
}

function sessionLink(value, label) {
  exactKeys(value, ['id', 'opens', 'template', 'parameters', 'platforms', 'notes', 'source'], label);
  if (!ID.test(value.id)) fail(`${label}.id must be a lowercase identifier`);
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) {
    fail(`${label}.parameters must be an object`);
  }
  const parameters = Object.fromEntries(Object.entries(value.parameters).map(([name, spec]) => {
    if (!PARAMETER.test(name)) fail(`${label}.parameters names must be camelCase identifiers`);
    exactKeys(spec, ['format'], `${label}.parameters.${name}`);
    if (!PARAMETER_FORMATS.has(spec.format)) fail(`${label}.parameters.${name}.format must be uuid or any`);
    return [name, Object.freeze({ format: spec.format })];
  }));
  if (!Array.isArray(value.platforms) || !value.platforms.length || new Set(value.platforms).size !== value.platforms.length
    || value.platforms.some(platform => !PLATFORMS.has(platform))) {
    fail(`${label}.platforms must list distinct platforms of ${[...PLATFORMS].join(', ')}`);
  }
  return Object.freeze({
    id: value.id, opens: text(value.opens, `${label}.opens`, 80), template: template(value, label),
    parameters: Object.freeze(parameters), platforms: Object.freeze([...value.platforms]),
    notes: text(value.notes, `${label}.notes`, 1000), source: httpsUrl(value.source, `${label}.source`)
  });
}

function client(value, index) {
  const label = `clients[${index}]`;
  exactKeys(value, ['id', 'name', 'sessionLinks', 'noSessionLink'], label);
  if (!ID.test(value.id)) fail(`${label}.id must be a lowercase identifier`);
  if (!Array.isArray(value.sessionLinks) || value.sessionLinks.length > MAX_LINKS) {
    fail(`${label}.sessionLinks must be a list of at most ${MAX_LINKS}`);
  }
  const links = value.sessionLinks.map((link, item) => sessionLink(link, `${label}.sessionLinks[${item}]`));
  if (new Set(links.map(link => link.id)).size !== links.length) fail(`${label}.sessionLinks ids must be distinct`);
  // A client without a verified link says why, so a person is never shown a guess.
  if (links.length ? value.noSessionLink !== null : value.noSessionLink === null) {
    fail(`${label}.noSessionLink is required exactly when there is no session link`);
  }
  return Object.freeze({ id: value.id, name: text(value.name, `${label}.name`, 80), sessionLinks: Object.freeze(links),
    noSessionLink: value.noSessionLink === null ? null : text(value.noSessionLink, `${label}.noSessionLink`, 500) });
}

/** A validated, frozen manifest; throws ClientLinksManifestError for anything else. */
export function parseClientLinksManifest(value) {
  exactKeys(value, ['format', 'formatVersion', 'manifestVersion', 'updatedAt', 'clients'], 'manifest');
  if (value.format !== CLIENT_LINKS_FORMAT_ID) fail(`format must be ${CLIENT_LINKS_FORMAT_ID}`);
  if (value.formatVersion !== CLIENT_LINKS_FORMAT_VERSION) {
    fail(`formatVersion ${value.formatVersion} is not ${CLIENT_LINKS_FORMAT_VERSION}, which this FULI reads`);
  }
  if (!Number.isSafeInteger(value.manifestVersion) || value.manifestVersion < 1) fail('manifestVersion must be a positive integer');
  if (typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.updatedAt)
    || Number.isNaN(Date.parse(value.updatedAt))) fail('updatedAt must be a date (YYYY-MM-DD)');
  if (!Array.isArray(value.clients) || !value.clients.length || value.clients.length > MAX_CLIENTS) {
    fail(`clients must list 1 to ${MAX_CLIENTS} clients`);
  }
  const clients = value.clients.map(client);
  if (new Set(clients.map(item => item.id)).size !== clients.length) fail('client ids must be distinct');
  return Object.freeze({ format: CLIENT_LINKS_FORMAT_ID, formatVersion: CLIENT_LINKS_FORMAT_VERSION,
    manifestVersion: value.manifestVersion, updatedAt: value.updatedAt, clients: Object.freeze(clients) });
}

/** What another manifest adds, changes and removes, by client. */
export function diffClientLinks(current, next) {
  const before = new Map(current.clients.map(item => [item.id, item]));
  const after = new Map(next.clients.map(item => [item.id, item]));
  const summary = item => ({ id: item.id, name: item.name });
  return {
    fromVersion: current.manifestVersion,
    toVersion: next.manifestVersion,
    added: next.clients.filter(item => !before.has(item.id)).map(summary),
    changed: next.clients.filter(item => before.has(item.id)).flatMap(item => {
      const old = before.get(item.id);
      const fields = ['name', 'sessionLinks', 'noSessionLink']
        .filter(field => JSON.stringify(old[field]) !== JSON.stringify(item[field]));
      return fields.length ? [{ ...summary(item), fields }] : [];
    }),
    removed: current.clients.filter(item => !after.has(item.id)).map(summary)
  };
}
