import { createHash } from 'node:crypto';
import { CHUNK_BYTES } from './owner-channel.js';
import { SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const denied = code => ({ ok: false, code });

// One pinned raw export per owner worker. A different or expired image must
// start again at its digest; chunks from different images never mix.
export function ownerExport({ owns, exportScope, now = Date.now }) {
  let kept = null;
  let timer;
  function clear() {
    clearTimeout(timer);
    kept = null;
  }
  function retain() {
    clearTimeout(timer);
    kept.expires = now() + 60_000;
    timer = setTimeout(clear, 60_000);
    timer.unref?.();
  }
  async function answer(job) {
    if (!owns(job)) return denied('scope_not_owned_here');
    if (job.action === 'export_digest' || job.action === 'inventory') {
      if (!kept || kept.job.scope !== job.scope || kept.job.spaceId !== job.spaceId ||
        kept.job.generation !== job.generation || kept.expires <= now()) {
        clear();
        let result;
        try { result = await exportScope(job); }
        catch (error) {
          if (error?.status === 413 || error?.code === 'scope_too_large') return denied('scope_too_large');
          throw error;
        }
        if (!owns(job) || result.scope !== job.scope || result.spaceId !== job.spaceId || result.complete !== true ||
          !/^[a-f0-9]{64}$/.test(result.digest) || typeof result.text !== 'string') return denied('export_unverified');
        if (Buffer.byteLength(result.text) > SCOPE_ENVELOPE_MAX_BYTES) return denied('scope_too_large');
        const bytes = Buffer.from(result.text);
        kept = { job, bytes, digest: result.digest, rawDigest: hash(bytes) };
        retain();
      }
      return { ok: true, digest: kept.digest, rawDigest: kept.rawDigest, bytes: kept.bytes.length };
    }
    const { offset, rawDigest } = job.input ?? {};
    if (job.action !== 'export_chunk' || !kept || kept.expires <= now() || job.spaceId !== kept.job.spaceId ||
      job.generation !== kept.job.generation || job.scope !== kept.job.scope || rawDigest !== kept.rawDigest ||
      !Number.isSafeInteger(offset) || offset < 0 || offset >= kept.bytes.length || offset % CHUNK_BYTES) {
      return denied('export_changed');
    }
    retain();
    return { ok: true, offset, rawDigest, data: kept.bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') };
  }
  return Object.assign(answer, { close: clear });
}

export async function readOwnerExport(ask, summary) {
  if (!summary?.ok || !Number.isInteger(summary.bytes) || summary.bytes < 1 || summary.bytes > SCOPE_ENVELOPE_MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(summary.rawDigest) || !/^[a-f0-9]{64}$/.test(summary.digest)) return denied('export_unverified');
  const output = Buffer.alloc(summary.bytes);
  for (let offset = 0; offset < output.length; offset += CHUNK_BYTES) {
    const response = await ask('export_chunk', { offset, rawDigest: summary.rawDigest });
    const chunk = response?.result;
    const length = Math.min(CHUNK_BYTES, output.length - offset);
    if (!response?.ok || !chunk?.ok || chunk.rawDigest !== summary.rawDigest || chunk.offset !== offset ||
      typeof chunk.data !== 'string' || chunk.data.length !== 4 * Math.ceil(length / 3)) return denied('export_changed');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.length !== length || bytes.toString('base64') !== chunk.data) return denied('export_invalid');
    bytes.copy(output, offset);
  }
  if (hash(output) !== summary.rawDigest) return denied('export_changed');
  try {
    return { ok: true, digest: summary.digest, text: new TextDecoder('utf-8', { fatal: true }).decode(output) };
  } catch { return denied('export_invalid'); }
}
