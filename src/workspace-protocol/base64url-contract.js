import { Buffer } from 'node:buffer';

import { z } from 'zod';

export function createCanonicalBase64UrlSchema(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError('byteLength must be a non-negative safe integer');
  }

  const encodedLength = Math.ceil(byteLength * 4 / 3);

  return z
    .string()
    .length(encodedLength)
    .refine((value) => {
      if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
        return false;
      }

      const decoded = Buffer.from(value, 'base64url');

      return (
        decoded.byteLength === byteLength
        && decoded.toString('base64url') === value
      );
    });
}
