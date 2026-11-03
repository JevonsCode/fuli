import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { DELEGATION_CATEGORIES } from '../agent-tools/interface-catalog.js';

// Which categories of console changes the person lets their FLAs make for
// them (AI permissions, rec#11 D-81). Only the person's own changes are kept;
// a category never changed reads as the catalog's default. A value for a name
// the catalog does not list is ignored: the file can open a delegable
// category, never a local-user-only change.
export const AGENT_DELEGATION_POLICY_FORMAT = jsonFormat({ store: 'agent-delegation-policy', versions: [1] });

export function createDelegationPolicyStore(path, { now = () => new Date().toISOString() } = {}) {
  let memory = null;
  const stored = () => (path ? readJsonFile(path, null) : memory);

  function read() {
    const record = stored();
    const choices = record?.version === 1 && isPlainObject(record.categories) ? record.categories : {};
    return {
      categories: DELEGATION_CATEGORIES.map(({ id, defaultEnabled }) => ({ id, defaultEnabled,
        enabled: typeof choices[id] === 'boolean' ? choices[id] : defaultEnabled })),
      updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null
    };
  }

  function setCategory(id, enabled) {
    const change = (current) => ({ version: 1,
      categories: { ...(isPlainObject(current?.categories) ? current.categories : {}), [id]: enabled },
      updatedAt: now() });
    if (path) updateVersionedJsonFileAtomic(path, AGENT_DELEGATION_POLICY_FORMAT, change);
    else memory = change(memory);
  }

  return { read, setCategory };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
