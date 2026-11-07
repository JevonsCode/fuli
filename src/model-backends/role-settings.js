import { z } from 'zod';

import { ApplicationError } from '../app/application-error.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';
import { updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import {
  MODEL_BACKEND_CONFIG_FORMAT, MODEL_BACKEND_ROLES, configRevision, normalizeConfig, readModelBackendConfig
} from './config.js';
import { keyOrigin } from './secret-store.js';

// One built-in Agent's model settings saved from the local console. Only the
// console's loopback route calls it (the local process boundary, not proof
// that a person sent the request); no MCP or Agent tool does. The edit names
// the saved configuration it started from: a file changed since then, or one
// that does not validate, is refused and left as it is.
// Keys never pass here; a connection names its key by secretRef only.
// history (settings-history.js) records what the save changed, after the file
// is written and under the same lock (rec#11 D-42). The save answers whether
// it was recorded; a failed record leaves the saved settings as they are.
// keyOrigins() maps each saved key to the origin it is tied to (secret-store.js):
// an edit that points a connection naming a tied key at another origin is
// refused, whoever sends it, so the key is saved again for the new endpoint.
// A key saved before origins were recorded and not tied yet (null) may stay
// on the origin its connection already had, and goes nowhere new: otherwise
// a later one-time binding could tie it to an address an Agent chose.

const EDIT = z.object({
  revision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  connectionId: z.string(),
  connection: z.record(z.string(), z.unknown()),
  settings: z.record(z.string(), z.unknown())
}).strict();

export function createModelRoleSettings(configPath, { history = null, keyOrigins = () => ({}) } = {}) {
  return {
    save(role, input) {
      if (!MODEL_BACKEND_ROLES.includes(role)) throw new TypeError(`Unknown role: ${role}`);
      const parsed = EDIT.safeParse(input);
      // The issue paths only, never the values: a key pasted in the wrong field stays unechoed.
      if (!parsed.success) {
        throw new TypeError(`Invalid model settings: ${parsed.error.issues.map(issue => issue.path.join('.') || 'input').join(', ')}`);
      }
      const edit = parsed.data;
      let before = null;
      let recorded = 'not_recorded';
      updateVersionedJsonFileAtomic(configPath, MODEL_BACKEND_CONFIG_FORMAT, () => {
        before = readModelBackendConfig(configPath);
        return withTiedKeys(before, nextConfig(before, role, edit), edit.connectionId, keyOrigins());
      }, { read: () => null, write(path, next) {
        writeJsonFileAtomic(path, next);
        recorded = record(history, role, before, next);
      } });
      return { history: recorded };
    }
  };
}

// After the file was written nothing may throw: a record that fails is not_recorded.
function record(history, role, before, next) {
  if (!history) return 'not_recorded';
  try {
    return history.recordSettings(role, before, next);
  } catch {
    return 'not_recorded';
  }
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

// The edited connection may name a saved key only for the origin that key is
// tied to; an untied one only where this connection already sent it.
function withTiedKeys(loaded, next, connectionId, origins) {
  const { secretRef, endpoint } = next.connections[connectionId];
  if (!secretRef || !Object.hasOwn(origins, secretRef)) return next;
  const origin = keyOrigin(endpoint);
  const previous = loaded.state === 'ok' ? loaded.config.connections[connectionId] : null;
  const allowed = origins[secretRef]
    ?? (previous?.secretRef === secretRef ? keyOrigin(previous.endpoint) : null);
  if (allowed !== origin) {
    throw new ApplicationError('key_endpoint_mismatch', allowed
      ? `The key ${secretRef} was saved for ${allowed}, not ${origin}. Nothing was saved; save the key again for the new endpoint first.`
      : `The key ${secretRef} is not tied to an endpoint yet. Nothing was saved; save the key again for ${origin} first.`,
    { status: 409 });
  }
  return next;
}
