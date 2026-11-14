import { installedClientPacks } from '../setup/agents/client-pack-store.js';
import { integrationContext } from '../setup/integration-context.js';
import { packManifestClient } from './pack-manifest.js';

// FULI's own MCP server entry for one client, exactly as agent-installer
// writes it into that client's configuration: the active descriptor pack's
// arguments (pack-manifest.js) with this installation's variables filled in
// (integration-context.js). The read-only wake of an ask from another computer
// loads only this entry (packages/roundtable deliver).
// Roundtable names clients by wake id; packs by client id.
const PACK_IDS = Object.freeze({ claude_code: 'claude-code', codex: 'codex' });

// Answers { command, args, settings } (settings: the client's own extra
// fields, such as Codex's tool approval mode) or null when this client has no
// pack entry here.
export function fuliMcpServerEntry({ paths, runtimeConfigPath, client, packs = installedClientPacks(paths.dataDir) }) {
  const pack = packs.find((candidate) => candidate.id === PACK_IDS[client]);
  if (!pack) return null;
  const context = integrationContext(paths, runtimeConfigPath);
  const variables = { '{mcpServerPath}': context.mcpServerPath, '{runtimeConfigPath}': context.runtimeConfigPath };
  const { args, extra = {} } = packManifestClient(pack).mcp;
  if (args.some((arg) => /^\{.+\}$/.test(arg) && !Object.hasOwn(variables, arg))) return null;
  return { command: context.nodePath, args: args.map((arg) => variables[arg] ?? arg), settings: extra };
}
