import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Streams the file, so its size never decides how much memory hashing takes.
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
