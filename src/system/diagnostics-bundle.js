import { closeSync, openSync, readSync, fstatSync } from 'node:fs';
import { arch, homedir, platform, release, userInfo } from 'node:os';
import { relative, sep } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { nativeInstanceLogPaths } from '../setup/paths.js';
import { createRedactor } from './diagnostics-redaction.js';

// 诊断包: what a person sends FULI's developers so they can tell what went
// wrong, previewed in the console before it leaves this computer (GET
// /api/system/diagnostics). It holds FULI's version and install kind, this
// computer's OS and Node, the runtime settings without personal values, the
// doctor's report and the end of each FULI log, all redacted
// (diagnostics-redaction.js). It never reads knowledge, transcripts, memory or
// project content: only the files and reports named here.
//
//   { generatedAt, files: [{ name, content }], redactions: { kind: count } }

const LOG_TAIL_LINES = 400;
// A log line can be long (a stack trace, a Neo4j query); a tail never reads more than this.
const LOG_TAIL_BYTES = 256 * 1024;

// paths: resolveSetupPaths(). doctor: the doctor's check (doctor.js).
// settings: { configured, active } runtime settings. installKind: how this
// FULI was installed and updates (console-update.js). host: this computer's
// facts, a seam for tests.
export function createDiagnosticsBundle({ paths, doctor, settings, installKind, host = currentHost(),
  now = () => new Date() }) {
  return async function diagnosticsBundle() {
    const redactor = createRedactor({ homeDir: host.homeDir, username: host.username });
    const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
    const files = [
      { name: 'about.json', content: json({ fuli: { version: FULI_VERSION, installKind: installKind() },
        os: { platform: host.platform, release: host.release, arch: host.arch }, node: host.nodeVersion }) },
      { name: 'settings.json', content: json(withoutPersonalValues(settings())) },
      { name: 'doctor.json', content: json(await doctorReport(doctor)) },
      ...logFiles(paths).flatMap((path) => {
        const content = readLogTail(path);
        return content === null ? [] : [{ name: relative(paths.dataDir, path).split(sep).join('/'), content }];
      })
    ].map(({ name, content }) => ({ name, content: redactor.redact(content) }));
    return { generatedAt: now().toISOString(), files, redactions: redactor.counts() };
  };
}

// Where FULI writes its logs: the console's, and each native graph instance's provider and Neo4j console.
function logFiles(paths) {
  return [paths.logPath, ...[paths.nativePersonalDir, paths.nativeWorkspaceDir].flatMap((instanceDir) => {
    const logs = nativeInstanceLogPaths(instanceDir);
    return [logs.provider, logs.database];
  })];
}

async function doctorReport(doctor) {
  try { return await doctor(); } catch (error) { return { error: error?.message ?? String(error) }; }
}

// What the person wrote into settings is theirs, not a diagnosis: say only whether it is set.
function withoutPersonalValues(settings) {
  const strip = (value) => value && {
    ...value,
    agentNamingStyle: Boolean(value.agentNamingStyle),
    notifications: { needsPersonUrl: Boolean(value.notifications?.needsPersonUrl) }
  };
  return { configured: strip(settings.configured), active: strip(settings.active) };
}

// The last LOG_TAIL_LINES lines of a log, or null when there is none. A log
// that cannot be read says why, so the bundle still shows it was there.
function readLogTail(path) {
  let descriptor = null;
  try {
    descriptor = openSync(path, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return '(could not be read: not a file)\n';
    const size = stat.size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(descriptor, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, read).toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // the first line was cut by the byte limit
    if (lines.at(-1) === '') lines.pop();
    return lines.length ? `${lines.slice(-LOG_TAIL_LINES).join('\n')}\n` : null;
  } catch (error) {
    return error.code === 'ENOENT' ? null : `(could not be read: ${error.code ?? 'error'})\n`;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function currentHost() {
  let username = null;
  try { username = userInfo().username; } catch { /* no account entry (some containers) */ }
  return { homeDir: homedir(), username, platform: platform(), release: release(), arch: arch(), nodeVersion: process.version };
}
