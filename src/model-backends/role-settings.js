import { z } from 'zod';

import { ApplicationError } from '../app/application-error.js';
import { updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import {
  MODEL_BACKEND_CONFIG_FORMAT, MODEL_BACKEND_ROLES, configRevision, normalizeConfig, readModelBackendConfig
} from './config.js';

// The person's edit of one built-in Agent's model settings in the local
// console. Only the console's loopback route reaches it; no MCP or Agent tool
// does. The edit names the saved configuration it started from: a file changed
// since then, or one that does not validate, is refused and left as it is.
// Keys never pass here; a connection names its key by secretRef only.

const EDIT = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  connectionId: z.string(),
  connection: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown())
}).strict();

export function createModelRoleSettings(configPath) {
  return {
    save(role, input) {
      if (!MODEL_BACKEND_ROLES.includes(role)) throw new TypeError(`Unknown role: ${role}`);
      const parsed = EDIT.safeParse(input);
      // The issue paths only, never the values: a key pasted in the wrong field stays unechoed.
      if (!parsed.success) {
        throw new TypeError(`Invalid model settings: ${parsed.error.issues.map(issue => issue.path.join('.') || 'input').join(', ')}`);
      }
      const edit = parsed.data;
      updateVersionedJsonFileAtomic(configPath, MODEL_BACKEND_CONFIG_FORMAT,
        () => nextConfig(readModelBackendConfig(configPath), role, edit), { read: () => null });
    }
  };
}

function nextConfig(loaded, role, { revision, connectionId, connection, settings }) {
  if (loaded.state === 'invalid') {
    throw new ApplicationError('model_config_invalid',
      `model-backends.json does not validate, so the console leaves it as it is: ${loaded.error}`, { status: 409 });
  }
  if (configRevision(loaded) !== revision) {
    throw new ApplicationError('model_config_changed',
      'The model settings changed since this page read them. Nothing was saved; read them again.', { status: 409 });
  }
  const current = loaded.state === 'ok' ? loaded.config : { version: 1, connections: {}, roles: {} };
  return normalizeConfig({
    version: current.version,
    connections: { ...current.connections, [connectionId]: connection },
    roles: { ...current.roles, [role]: { ...settings, connection: connectionId } }
  });
}
