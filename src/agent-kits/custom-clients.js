import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  // already in the directory is never replaced. takenFiles: the MCP files of
  // the clients it lists (`~/…` or absolute); another client's file is never
  // named again, so two writers never take turns in it.
  function add(input, takenIds, takenFiles = []) {
    if (!extensionsDir) throw new TypeError('This machine has no shared agent-clients directory');
    const name = requiredString(input?.name, 'name', MAX_NAME).trim();
    if (/[\r\n]/.test(name)) throw new InvalidInputError('name must be one line');
    const format = input?.format ?? CUSTOM_CLIENT_FORMATS[0];
    if (!CUSTOM_CLIENT_FORMATS.includes(format)) throw new InvalidInputError(`format must be one of ${CUSTOM_CLIENT_FORMATS.join(', ')}`);
    const file = homePath(requiredString(input?.mcpFile, 'mcpFile').trim(), home);
    // Optional: the folder where the client reads Skills (one folder per Skill with its SKILL.md).
    const skillsDir = typeof input?.skillsDir === 'string' && input.skillsDir.trim()
      ? homePath(input.skillsDir.trim(), home, 'skillsDir', '~/.acme/skills') : null;
    const key = comparable(file, home);
    if (takenFiles.some((taken) => comparable(taken, home) === key)) {
      throw new InvalidInputError('mcpFile is the configuration file of a client already listed; name the file of the client you are adding');
    }
    const id = uniqueId(slug(name), new Set([...takenIds, ...fileIds()]));
    writeJsonFileAtomic(fileOf(id), { schemaVersion: 1, name,
      install: { detect: [{ path: file }], mcp: { file, format }, ...(skillsDir ? { skills: { dir: skillsDir } } : {}) } });
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

// The installer takes paths under the home directory as `~/…` with `/`, and
// refuses `..`; so does FULI, in both forms and with either separator, and the
// resolved file must be inside the home folder.
const TILDE = /^~(?:[\\/]|$)/;

function homePath(path, home, field = 'mcpFile', example = '~/.acme/mcp.json') {
  const resolved = TILDE.test(path) ? join(home, path.slice(1).replaceAll('\\', '/')) : isAbsolute(path) ? path : null;
  const inside = resolved === null ? null : relative(home, resolved);
  if (!inside || path.split(/[\\/]/).includes('..') || inside.split(sep)[0] === '..' || isAbsolute(inside)) {
    throw new InvalidInputError(`${field} must be in your home folder, such as ${example}`);
  }
  return `~/${inside.split(sep).join('/')}`;
}

// One file's path in a form two spellings of it share; null when it is not
// one FULI can place (an installer path with another root).
function comparable(path, home) {
  const absolute = TILDE.test(path) ? join(home, path.slice(1)) : isAbsolute(path) ? resolve(path) : null;
  return absolute && (process.platform === 'linux' ? absolute : absolute.toLowerCase());
}

function slug(name) {
  const text = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 48);
  return CLIENT_ID.test(text) ? text : FALLBACK_ID;
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}
