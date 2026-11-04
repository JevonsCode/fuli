import { AGENT_DELEGATION_FORMAT } from '../agent-delegation/operation-log.js';
import { AGENT_DELEGATION_POLICY_FORMAT } from '../agent-delegation/policy-store.js';
import { AGENT_ACCESS_POLICY_FORMAT } from '../graphiti/agent-access-policy.js';
import { GRAPH_RUNTIME_CONFIG_FORMAT } from '../graphiti/runtime-config.js';
import { MODEL_BACKEND_CONFIG_FORMAT } from '../model-backends/config.js';
import { MODEL_SECRETS_FORMAT } from '../model-backends/secret-store.js';

// Old data an Agent must not reach through the shelf. A backup of a store that
// holds credentials, and a copy of a client's config (it may carry MCP tokens),
// are listed but never read. Those stores, what limits an Agent and the record
// of what Agents did go back only by the person's own click: an FLA restoring
// them could undo the limits on itself or the record of its actions.
const SECRET_STORES = new Set([MODEL_SECRETS_FORMAT.store, MODEL_BACKEND_CONFIG_FORMAT.store, GRAPH_RUNTIME_CONFIG_FORMAT.store]);
const PERSON_ONLY_RESTORES = new Set([...SECRET_STORES, AGENT_ACCESS_POLICY_FORMAT.store,
  AGENT_DELEGATION_POLICY_FORMAT.store, AGENT_DELEGATION_FORMAT.store]);

export const unreadable = (item) => item.kind === 'client_config_backup' || SECRET_STORES.has(item.store);
export const personOnlyRestore = (item) => PERSON_ONLY_RESTORES.has(item.store);
