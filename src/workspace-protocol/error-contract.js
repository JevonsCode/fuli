import { z } from 'zod';

import { idSchema } from './scalar-contract.js';
import { createPreservedSemanticTextSchema } from './text-contract.js';

export const ProtocolErrorCode = Object.freeze({
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  CURSOR_EXPIRED: 'CURSOR_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROTOCOL_INCOMPATIBLE: 'PROTOCOL_INCOMPATIBLE',
});

export const protocolErrorResponseSchema = z.strictObject({
  code: z.enum(Object.values(ProtocolErrorCode)),
  message: createPreservedSemanticTextSchema(500),
  traceId: idSchema,
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
});
