import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { packageIdentifier, packageVersion } from '../../employees/manifest.js';
import { sha256Bytes } from '../../security/digest.js';
import { parseClientDescriptor } from './descriptor-schema.js';

const MAX_BYTES = 1024 * 1024;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const manifestSchema = z.object({ schemaVersion: z.literal(1), entries: z.array(z.object({
  id: packageIdentifier, version: packageVersion, sha256: digest, source: z.string().min(1)
}).strict()).max(100) }).strict();

// No discovery endpoint or implicit trust: every read is bound to exact user-pinned bytes.
export async function readPinnedClientManifest({ source, sha256 }, { fetchImpl = fetch } = {}) {
  digest.parse(sha256);
  const bytes = await readSource(source, fetchImpl);
  if (bytes === null) return { status: 'unavailable', packs: [] };
  verify(bytes, sha256, 'Manifest');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const seen = new Set();
  const packs = [];
  for (const entry of manifest.entries) {
    if (seen.has(entry.id)) throw new TypeError(`Duplicate client manifest id: ${entry.id}`);
    seen.add(entry.id);
    const target = packSource(source, entry.source);
    const packBytes = await readSource(target, fetchImpl);
    if (packBytes === null) return { status: 'unavailable', packs: [] };
    verify(packBytes, entry.sha256, `Pack ${entry.id}`);
    const pack = parseClientDescriptor(JSON.parse(packBytes.toString('utf8')));
    if (pack.id !== entry.id || pack.version !== entry.version) throw new TypeError('Pack identity does not match manifest');
    packs.push(pack);
  }
  return { status: 'verified', packs };
}
function verify(bytes, expected, label) {
  if (sha256Bytes(bytes) !== expected) throw new TypeError(`${label} digest mismatch`);
}
function httpsSource(source) {
  if (!/^https?:\/\//i.test(source)) return null;
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('Client sources require HTTPS without credentials or fragment');
  return url;
}
function packSource(manifestSource, source) {
  if (httpsSource(source)) return source;
  if (httpsSource(manifestSource)) throw new TypeError('Remote manifests require HTTPS pack sources');
  if (isAbsolute(source) || /^[a-z][a-z0-9+.-]*:/i.test(source)) throw new TypeError('Local pack sources must be relative to the manifest directory');
  const base = realpathSync(dirname(resolve(manifestSource)));
  let target = resolve(base, source);
  try { target = realpathSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const child = relative(base, target);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new TypeError('Pack source escapes manifest directory');
  return target;
}
async function readSource(source, fetchImpl) {
  const url = httpsSource(source);
  if (!url) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) throw new TypeError('Client sources require HTTPS');
    try { const bytes = readFileSync(source); checkSize(bytes.length); return bytes; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { return null; }
  if (!response.ok) return null;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; checkSize(size); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function checkSize(size) { if (size > MAX_BYTES) throw new TypeError('Client manifest or pack exceeds 1 MiB'); }
