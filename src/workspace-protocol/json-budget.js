import { Buffer } from 'node:buffer';

export function utf8JsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function refineUtf8JsonByteBudget(
  value,
  context,
  maxBytes,
  label,
) {
  if (utf8JsonByteLength(value) > maxBytes) {
    context.addIssue({
      code: 'custom',
      message: `${label} exceeds the aggregate UTF-8 JSON byte budget`,
    });
  }
}
