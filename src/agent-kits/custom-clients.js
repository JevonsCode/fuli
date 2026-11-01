import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { InvalidInputError } from '../app/application-error.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';
import { requiredString } from '../validation/values.js';

// Clients a person adds by hand (a company's own agent client, say): one
// `<client-id>.json` in the shared agent-clients extension directory, with
// only an `install` section, so agent-installer detects FULI in it and
// reports it like a built-in client. The session launcher ignores such a
// file (it has no `launch`). FULI removes only files of this shape.
const FILE_KEYS = new Set(['schemaVersion', 'name', 'install']);
// The MCP file formats a person picks from (agent-installer's write formats).
const CUSTOM_CLIENT_FORMATS = Object.freeze(['mcp-servers-json', 'opencode-json', 'codex-toml']);
const MAX_NAME = 64;
// agent-installer's client ID rule for extension file names.
const CLIENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const FALLBACK_ID = 'custom-client';

// extensionsDir: the shared extension directory (the installer port's).
export function customClientStore({ extensionsDir, home = homedir() }) {
  function fileOf(id) {
    return join(extensionsDir, `${id}.json`);
  }
  function read(id) {
    try { return JSON.parse(readFileSync(fileOf(id), 'utf8')); } catch { return null; }
  }
  function fileIds() {
    try {
      return readdirSync(extensionsDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    } catch { return []; }
  }
  // IDs of the custom clients FULI may remove.
  function removable() {
    return new Set(fileIds().filter((id) => CLIENT_ID.test(id) && ownShape(read(id))));
  }
  // takenIds: client IDs the installer already lists, built-in or not. A file
  // already in the directory is never replaced.
  function add(input, takenIds) {
    if (!extensionsDir) throw new TypeError('This machine has no shared agent-clients directory');
    const name = requiredString(input?.name, 'name', MAX_NAME).trim();
    if (/[\r\n]/.test(name)) throw new InvalidInputError('name must be one line');
    const format = input?.format ?? CUSTOM_CLIENT_FORMATS[0];
    if (!CUSTOM_CLIENT_FORMATS.includes(format)) throw new InvalidInputError(`format must be one of ${CUSTOM_CLIENT_FORMATS.join(', ')}`);
    const file = homePath(requiredString(input?.mcpFile, 'mcpFile').trim(), home);
    const id = uniqueId(slug(name), new Set([...takenIds, ...fileIds()]));
    writeJsonFileAtomic(fileOf(id), { schemaVersion: 1, name,
      install: { detect: [{ path: file }], mcp: { file, format } } });
    return { id };
  }
  function remove(id) {
    if (typeof id !== 'string' || !removable().has(id)) throw new InvalidInputError('clientId must name a client added here');
    unlinkSync(fileOf(id));
  }
  return { removable, add, remove };
}

function ownShape(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => FILE_KEYS.has(key)) && Object.hasOwn(value, 'install');
}

// The installer takes paths under the home directory as `~/…` with `/`.
function homePath(path, home) {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return path.replaceAll('\\', '/');
  const inside = isAbsolute(path) ? relative(home, path) : null;
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new InvalidInputError('mcpFile must be a file in your home folder, such as ~/.acme/mcp.json');
  }
  return `~/${inside.split(sep).join('/')}`;
}

function slug(name) {
  const text = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 48);
  return CLIENT_ID.test(text) ? text : FALLBACK_ID;
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}
