import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';

import { detectClients, entryState } from '../agent-kits/client-detection.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { resolveSetupPaths } from '../setup/paths.js';

// Which data an npm copy of FULI serves, as its Agent clients say: a client
// FULI was connected to from that copy names the copy's MCP server and the
// runtime configuration (`--runtime-config <dataDir>/graph-runtime.json`) in
// its own configuration file. agent-installer names those files; they are
// only read here, as text, never parsed in a client's own format or written.
// A client whose entry is a plugin directory (DeepSeek Harness's bundle, whose
// index.js and cordis.patch.yml name the copy) is read file by file, one level
// deep.
//
// Answers Map(packageRoot → { shares: true | false | null, dataDir }): true
// when a client of that copy uses this data directory, false (with that
// other dataDir) when one uses another, null when no client names the copy.

const PRESENT = new Set(['current', 'outdated', 'conflict']);

export function npmCopyDataUse(copies, { runtimeConfigPath, clients, homeDir = homedir(), readText = readFileSync,
  listFiles = filesIn, platform = process.platform }) {
  // Paths in any client's file, JSON- or TOML-escaped or not, compared with
  // forward slashes, and without case on Windows.
  const normal = (path) => String(path).replaceAll('\\\\', '\\').replaceAll('\\', '/').replace(/\/+$/, '');
  const key = (path) => platform === 'win32' ? path.toLowerCase() : path;
  const native = (path) => platform === 'win32' ? path.replaceAll('/', '\\') : path;
  const texts = clients.filter((client) => PRESENT.has(entryState(client.components)))
    .flatMap((client) => client.entryPaths ?? client.mcpPaths ?? [])
    .flatMap((path) => listFiles(path.replace(/^~(?=[\\/])/, homeDir)))
    .map((path) => { try { return normal(readText(path, 'utf8')); } catch { return null; } })
    .filter(Boolean);
  const ours = key(normal(runtimeConfigPath));
  const answer = new Map();
  for (const copy of copies) {
    const root = key(normal(copy.packageRoot));
    const configs = texts.filter((text) => key(text).includes(root))
      .flatMap((text) => [...text.matchAll(/--runtime-config["']?\s*[,=:]?\s*["']([^"']+)["']/g)].map((match) => match[1]));
    const other = configs.find((config) => key(config) !== ours);
    answer.set(copy.packageRoot, other ? { shares: false, dataDir: native(posix.dirname(other)) }
      : configs.length ? { shares: true, dataDir: null } : { shares: null, dataDir: null });
  }
  return answer;
}

// A file as itself; a directory as the files directly in it.
function filesIn(path) {
  try {
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(path, entry.name));
  } catch {
    return [path];
  }
}

// The clients agent-installer finds, read for the desktop app's own data directory.
export async function clientDataUse(context, copies, { detect = detectClients } = {}) {
  const paths = resolveSetupPaths({ dataDir: context.dataDir, packageRoot: context.packageRoot });
  const answer = await detect(agentKitPorts(paths).clientInstaller);
  if (answer.status !== 'available') return new Map();
  return npmCopyDataUse(copies, { runtimeConfigPath: join(context.dataDir, 'graph-runtime.json'), clients: answer.clients });
}
