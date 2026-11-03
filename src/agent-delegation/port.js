import { join } from 'node:path';

import { DELEGATION_CATEGORIES, interfaceForRequest } from '../agent-tools/interface-catalog.js';
import { InvalidInputError } from '../app/application-error.js';
import { DelegatedOperationLog } from './operation-log.js';
import { createDelegationPolicyStore } from './policy-store.js';
import { agentAccessOffRefusal, categoryOffRefusal, delegableEntry } from './refusals.js';

// What the person lets their FLAs do for them in the console (AI
// permissions, rec#11 D-81) and the record of each change an FLA made. The
// console's loopback routes and its delegation gate are the only users.
const DELEGATION_POLICY_FILE = 'agent-delegation-policy.json';
const DELEGATION_LOG_FILE = 'agent-delegation.sqlite';
const RECENT_LIMIT = 20;

// dataDir: the data directory; null keeps both in memory.
export function createAgentDelegation(dataDir, { now = () => new Date().toISOString() } = {}) {
  const policy = createDelegationPolicyStore(dataDir ? join(dataDir, DELEGATION_POLICY_FILE) : null, { now });
  const log = new DelegatedOperationLog(dataDir ? join(dataDir, DELEGATION_LOG_FILE) : ':memory:');

  const read = () => ({ ...policy.read(), operations: log.recent(RECENT_LIMIT) });

  return {
    read,

    setCategory(id, enabled) {
      if (!DELEGATION_CATEGORIES.some((category) => category.id === id)) {
        throw new InvalidInputError(`category must be one of ${DELEGATION_CATEGORIES.map((category) => category.id).join(', ')}`);
      }
      if (typeof enabled !== 'boolean') throw new InvalidInputError('enabled must be true or false');
      policy.setCategory(id, enabled);
      return read();
    },

    // The catalog entry an FLA's request may run, or the refusal that says
    // why not. The catalog decides first: no policy value opens a
    // local-user-only change.
    authorize(method, pathname, { agentAccessEnabled }) {
      if (!agentAccessEnabled) throw agentAccessOffRefusal();
      const entry = delegableEntry(interfaceForRequest(method, pathname));
      if (!policy.read().categories.find((category) => category.id === entry.category)?.enabled) {
        throw categoryOffRefusal();
      }
      return entry;
    },

    record({ id, entry, path, call, status }) {
      log.record({ id, at: now(), route: entry.route, path, category: entry.category, actor: call.actor,
        reason: call.reason, bodyFields: call.bodyFields, status, outcome: status < 400 ? 'succeeded' : 'failed',
        undo: entry.undo });
    },

    close: () => log.close()
  };
}
