import { createHash } from 'node:crypto';

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
