import { claudeTranscriptFormat } from './claude-code/transcript-format-probe.js';
import { codexTranscriptFormat } from './codex/transcript-format-probe.js';
import { newestTranscript } from './transcript-format-scan.js';

// The doctor's port to each Agent's transcript format probe: whether FULI's
// parser still reads the private transcript format of each client it captures.
// Answers { [clientId]: { readable: true, recognized, total } | { readable: false, reason } }.
// Only a transcript changed within the last week counts; a client without one
// answers no_transcript. The console polls the doctor, so an answer is kept
// for ten minutes.
const TRANSCRIPT_FORMATS = Object.freeze([claudeTranscriptFormat, codexTranscriptFormat]);
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_CACHE_MS = 10 * 60 * 1000;

export function createTranscriptFormatProbe({ formats = TRANSCRIPT_FORMATS, env = process.env,
  cacheMs = PROBE_CACHE_MS, now = () => Date.now() } = {}) {
  let cached = null;
  return async function read() {
    if (cached && now() - cached.at < cacheMs) return cached.result;
    const result = Object.fromEntries(await Promise.all(formats.map(async (format) =>
      [format.clientId, await probeFormat(format, env, now())])));
    cached = { at: now(), result };
    return result;
  };
}

async function probeFormat(format, env, at) {
  try {
    const path = await newestTranscript(format.root(env), { depth: format.depth, since: at - RECENT_MS });
    return path ? await format.probe(path) : { readable: false, reason: 'no_transcript' };
  } catch {
    return { readable: false, reason: 'transcript_unreadable' };
  }
}
