import { join } from 'node:path';

import { sha256Bytes } from '../security/digest.js';
import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';

// Which client a session ran in, as the session launcher classified it when
// the session's hook first ran (rec#11 D-79): one small record per session,
// keyed by FULI's source application and the session ID. A session recorded
// before this existed has no record; its client is classified from the source
// application alone when it is needed.
export const SESSION_CLIENT_FORMAT = jsonFormat({ store: 'session-clients', versions: [1] });
const RECORD_VERSION = 1;
// The longest label or entry point name kept; Claude Code's entry points are short words like `cli`.
const MAX_TEXT = 64;

// What FULI's source applications are called in the launcher's catalog, for a
// session with no record. Labels the launcher reads as ambiguous (Codex,
// OpenCode) stay ambiguous: FULI never guesses a surface.
const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  claude: 'Claude Desktop',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  gemini_cli: 'Gemini CLI',
  kiro: 'Kiro',
  opencode: 'OpenCode',
  other: 'unknown'
});

export function sourceLabel(sourceApplication) {
  return SOURCE_LABELS[sourceApplication] ?? SOURCE_LABELS.other;
}

export function sessionClientRecords(dataDir) {
  const pathOf = (sourceApplication, sessionId) =>
    join(dataDir, 'session-clients', `${sha256Bytes(`${sourceApplication}\0${sessionId}`)}.json`);
  return {
    // { client, source, entrypoint } or null.
    read(sourceApplication, sessionId) {
      let record;
      try { record = readJsonFile(pathOf(sourceApplication, sessionId), null); } catch { return null; }
      if (record?.version !== RECORD_VERSION || record.sourceApplication !== sourceApplication
          || record.sessionId !== sessionId) return null;
      return { client: record.client ?? null, source: record.source ?? null, entrypoint: record.entrypoint ?? null };
    },
    // source: the label the Agent's adapter gave the launcher; client: the
    // launcher's answer, or null when it could not be asked. The label and
    // entry point are kept so the client can be classified later.
    record(sourceApplication, sessionId, { client = null, source, entrypoint = null }) {
      writeVersionedJsonFileAtomic(pathOf(sourceApplication, sessionId), {
        version: RECORD_VERSION, sourceApplication, sessionId, client, source: source.slice(0, MAX_TEXT),
        entrypoint: typeof entrypoint === 'string' ? entrypoint.slice(0, MAX_TEXT) : null
      }, SESSION_CLIENT_FORMAT);
    }
  };
}
