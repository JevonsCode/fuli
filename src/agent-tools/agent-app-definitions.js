import { MAX_APP_FILE_CONTENT_LENGTH, MAX_APP_FILES } from '../agent-apps/package-files.js';
import { arraySchema, enumSchema, objectSchema, stringSchema } from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 256 };

// Agents may only submit and read. Approving, disabling, rolling back and
// deleting apps have no Agent tool; they come through the CLI or local console.
// No app is ever granted these two (src/agent-apps/host-tools/catalog.js).
export const AGENT_APP_TOOL_DEFINITIONS = [
  {
    name: 'submit_agent_app_version', title: 'WRITE · Submit an Agent app version',
    description: 'Submit one immutable version of an app this Agent built for a real, repeated need. It stays pending; Agents cannot approve or remove apps (fuli app does); approved apps run unsandboxed. manifest: {schemaVersion:1, name:a-z0-9-, version:x.y.z, title, description, permissions:["fuli.<tool>"], runtime:{apiVersion:1, entry?:service file, webRoot?:dir with index.html}, resident?:bool, data:{scope:"app", format:N, accepts?:[N], migration?:none|reversible|irreversible} or {scope:"none"}}. files: relative visible paths, at most 128 files and 1 MiB. Same version and files is idempotent; changed files need a new version.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      agentId: id,
      manifest: { type: 'object', additionalProperties: true },
      files: arraySchema(objectSchema({
        path: { ...stringSchema(), minLength: 1, maxLength: 160 },
        content: { ...stringSchema(), maxLength: MAX_APP_FILE_CONTENT_LENGTH },
        encoding: enumSchema(['utf8', 'base64'])
      }, ['path', 'content']), { minItems: 1, maxItems: MAX_APP_FILES })
    }, ['personalSpaceId', 'agentId', 'manifest', 'files'])
  },
  {
    name: 'list_agent_apps', title: 'READ · List Agent apps',
    description: 'Agent apps with owner, type, status, versions, last use and data size; appId reads one app\'s versions, digests, permissions, approvals and history. Read-only.',
    inputSchema: objectSchema({ personalSpaceId: id, agentId: id, appId: id })
  }
];
