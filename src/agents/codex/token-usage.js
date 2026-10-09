import { constants } from 'node:fs';
import { lstat, opendir, open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_USAGE_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 128;
const MAX_DIRECTORY_ENTRIES = 2048;
const MAX_DIRECTORY_DEPTH = 8;

/**
 * Codex's native JSONL session adapter. It returns only the latest cumulative
 * token_count snapshot and never returns transcript records or text.
 */
export function createCodexTokenUsageResolver({
  sessionsDirectory = undefined,
  archivedSessionsDirectory = undefined,
  codexSessionsDirectory = undefined,
  codexArchivedSessionsDirectory = undefined,
  codexHomeDirectory = undefined,
  homeDirectory = undefined
} = {}) {
  const explicitSessionsDirectory = sessionsDirectory ?? codexSessionsDirectory;
  const explicitArchivedSessionsDirectory =
    archivedSessionsDirectory ?? codexArchivedSessionsDirectory;
  const home = typeof homeDirectory === 'string' && homeDirectory
    ? homeDirectory : defaultHomeDirectory();
  const codexHome = typeof codexHomeDirectory === 'string' && codexHomeDirectory
    ? codexHomeDirectory
    : homeDirectory === undefined ? (defaultCodexHomeDirectory() ?? (home ? join(home, '.codex') : null))
      : (home ? join(home, '.codex') : null);
  const useDefaultRoots = explicitSessionsDirectory === undefined &&
    explicitArchivedSessionsDirectory === undefined;
  const roots = [
    explicitSessionsDirectory ?? (useDefaultRoots && codexHome ? join(codexHome, 'sessions') : null),
    explicitArchivedSessionsDirectory ??
      (useDefaultRoots && codexHome ? join(codexHome, 'archived_sessions') : null)
  ]
    .filter((root, index, values) => typeof root === 'string' && root && values.indexOf(root) === index);
  return {
    resolve: (request) => resolveCodexTokenUsage(request, { roots })
  };
}

export async function resolveCodexTokenUsage(request = {}, { roots } = {}) {
  const sessionId = safeSessionId(request.sessionId ?? request.session_id);
  if (!sessionId) return null;
  const configuredRoots = Array.isArray(roots) ? roots : roots ? [roots] : null;
  const directories = (configuredRoots ?? [
    defaultCodexSessionsDirectory(),
    defaultCodexArchivedSessionsDirectory()
  ]).filter((root, index, values) => typeof root === 'string' && root && values.indexOf(root) === index);

  let inspectedEntries = 0;
  let candidates = 0;
  for (const root of directories) {
    const files = await matchingSessionFiles(root, sessionId, {
      onEntry: () => { inspectedEntries += 1; },
      get entriesInspected() { return inspectedEntries; },
      get candidatesFound() { return candidates; },
      addCandidate: () => { candidates += 1; }
    });
    for (const file of files) {
      const usage = await readSessionUsage(file, sessionId);
      if (usage) return usage;
    }
    if (inspectedEntries >= MAX_DIRECTORY_ENTRIES || candidates >= MAX_CANDIDATE_FILES) break;
  }
  return null;
}

async function matchingSessionFiles(root, sessionId, counters, depth = 0) {
  if (depth > MAX_DIRECTORY_DEPTH || counters.entriesInspected >= MAX_DIRECTORY_ENTRIES ||
      counters.candidatesFound >= MAX_CANDIDATE_FILES) return [];
  let directory;
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) return [];
    directory = await opendir(root);
  } catch {
    return [];
  }

  const files = [];
  try {
    for await (const entry of directory) {
      counters.onEntry();
      if (counters.entriesInspected > MAX_DIRECTORY_ENTRIES ||
          counters.candidatesFound >= MAX_CANDIDATE_FILES) break;
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await matchingSessionFiles(path, sessionId, counters, depth + 1));
        continue;
      }
      if (!entry.isFile() || extname(entry.name) !== '.jsonl' ||
          !basename(entry.name).includes(sessionId)) continue;
      counters.addCandidate();
      files.push(path);
    }
  } catch {
    // A session directory can rotate while the host is running. An incomplete
    // scan is an unavailable snapshot, never a reason to guess another file.
  } finally {
    await directory.close().catch(() => {});
  }
  return files;
}

async function readSessionUsage(filePath, sessionId) {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0) return null;

    const header = await readBytes(file, Math.min(MAX_HEADER_BYTES, stat.size), 0);
    const firstLineEnd = header.indexOf(10);
    if (firstLineEnd < 0 || !isSessionHeader(header.subarray(0, firstLineEnd), sessionId)) {
      return null;
    }

    const start = Math.max(0, stat.size - MAX_USAGE_TAIL_BYTES);
    const tail = await readBytes(file, stat.size - start, start);
    let firstLine = 0;
    if (start > 0) {
      const previous = await readBytes(file, 1, start - 1);
      if (previous[0] !== 10) {
        firstLine = tail.indexOf(10) + 1;
        if (firstLine <= 0) return null;
      }
    }
    return latestTokenUsage(tail.subarray(firstLine));
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function readBytes(file, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

function isSessionHeader(bytes, sessionId) {
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    return record?.type === 'session_meta' && record.payload?.id === sessionId;
  } catch {
    return false;
  }
}

function latestTokenUsage(bytes) {
  let latest = null;
  const text = bytes.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    const line = text.slice(offset, end < 0 ? text.length : end).trim();
    if (line.includes('"token_count"') && line.includes('"total_token_usage"')) {
      try {
        const record = JSON.parse(line);
        const total = record?.payload?.info?.total_token_usage;
        if (record?.type === 'event_msg' && record.payload?.type === 'token_count') {
          const totalTokens = nonNegativeInteger(total?.total_tokens);
          if (totalTokens !== null) {
            latest = {
              source: 'host',
              totalTokens,
              inputTokens: optionalNonNegativeInteger(total?.input_tokens),
              outputTokens: optionalNonNegativeInteger(total?.output_tokens),
              cachedInputTokens: optionalNonNegativeInteger(total?.cached_input_tokens),
              cacheWriteInputTokens: optionalNonNegativeInteger(total?.cache_write_input_tokens),
              reasoningOutputTokens: optionalNonNegativeInteger(total?.reasoning_output_tokens)
            };
          }
        }
      } catch {
        // Ignore malformed native records and continue to later snapshots.
      }
    }
    if (end < 0) break;
    offset = end + 1;
  }
  return latest;
}

function optionalNonNegativeInteger(value) {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeSessionId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('..') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) return null;
  return normalized;
}

function defaultCodexSessionsDirectory() {
  const codexHome = defaultCodexRootDirectory();
  return codexHome ? join(codexHome, 'sessions') : null;
}

function defaultCodexArchivedSessionsDirectory() {
  const codexHome = defaultCodexRootDirectory();
  return codexHome ? join(codexHome, 'archived_sessions') : null;
}

function defaultCodexRootDirectory() {
  const configured = defaultCodexHomeDirectory();
  if (configured) return configured;
  const home = defaultHomeDirectory();
  return home ? join(home, '.codex') : null;
}

function defaultCodexHomeDirectory() {
  const value = process.env.CODEX_HOME;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultHomeDirectory() {
  return process.env.HOME ?? process.env.USERPROFILE ?? null;
}
