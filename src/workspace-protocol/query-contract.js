import { z } from 'zod';

import { rejectDuplicateValues } from './array-validation.js';
import { factProjectionSchema } from './fact-contract.js';
import { refineUtf8JsonByteBudget } from './json-budget.js';
import {
  cursorSchema,
  idSchema,
  revisionSchema,
  timestampSchema,
} from './scalar-contract.js';
import { createNormalizedSemanticTextSchema } from './text-contract.js';
import { parseProtocolValue } from './validation.js';

const MAX_CONTEXT_PACK_BYTES = 1_048_576;

const initialWorkspaceQuerySchema = z
  .strictObject({
    text: createNormalizedSemanticTextSchema(512).optional(),
    subjects: z.array(createNormalizedSemanticTextSchema(500)).max(20).default([]),
    predicates: z.array(createNormalizedSemanticTextSchema(160)).max(20).default([]),
    factIds: z.array(idSchema).max(50).default([]),
    asOf: timestampSchema.optional(),
    includeHistory: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.literal(null).default(null),
  })
  .superRefine((query, context) => {
    rejectDuplicateValues(
      query.subjects,
      context,
      (index) => ['subjects', index],
    );
    rejectDuplicateValues(
      query.predicates,
      context,
      (index) => ['predicates', index],
    );
    rejectDuplicateValues(
      query.factIds,
      context,
      (index) => ['factIds', index],
    );

    if (
      query.text === undefined
      && query.subjects.length === 0
      && query.predicates.length === 0
      && query.factIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'At least one query selector is required',
      });
    }
  });

const continuationWorkspaceQuerySchema = z.strictObject({
  cursor: cursorSchema,
});

export const workspaceQuerySchema = z.union([
  continuationWorkspaceQuerySchema,
  initialWorkspaceQuerySchema,
]);

export const contextPackSchema = z
  .strictObject({
    workspaceId: idSchema,
    workspaceRevision: revisionSchema,
    generatedAt: timestampSchema,
    freshness: z.strictObject({
      state: z.enum(['fresh', 'stale']),
      lastSyncedAt: timestampSchema,
    }),
    facts: z.array(factProjectionSchema).max(100),
    nextCursor: cursorSchema.nullable(),
    truncated: z.boolean(),
  })
  .superRefine((contextPack, context) => {
    rejectDuplicateValues(
      contextPack.facts.map(({ id }) => id),
      context,
      (index) => ['facts', index, 'id'],
    );

    const workspaceRevision = BigInt(contextPack.workspaceRevision);

    contextPack.facts.forEach(({ revision }, index) => {
      if (BigInt(revision) > workspaceRevision) {
        context.addIssue({
          code: 'custom',
          path: ['facts', index, 'revision'],
          message: 'Fact revision cannot exceed the Context Pack workspace revision',
        });
      }
    });

    if (contextPack.truncated && contextPack.nextCursor === null) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'A truncated Context Pack requires a next cursor',
      });
    }

    if (!contextPack.truncated && contextPack.nextCursor !== null) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'A complete Context Pack cannot have a next cursor',
      });
    }

    const generatedAtEpoch = Date.parse(contextPack.generatedAt);

    contextPack.facts.forEach(({ recordedAt }, index) => {
      if (Date.parse(recordedAt) > generatedAtEpoch) {
        context.addIssue({
          code: 'custom',
          path: ['facts', index, 'recordedAt'],
          message: 'Fact recording time cannot follow Context Pack generation',
        });
      }
    });

    if (Date.parse(contextPack.freshness.lastSyncedAt) > generatedAtEpoch) {
      context.addIssue({
        code: 'custom',
        path: ['freshness', 'lastSyncedAt'],
        message: 'Sync time cannot follow Context Pack generation',
      });
    }

    refineUtf8JsonByteBudget(
      contextPack,
      context,
      MAX_CONTEXT_PACK_BYTES,
      'Context Pack',
    );
  });

export function parseWorkspaceQuery(value) {
  return parseProtocolValue(workspaceQuerySchema, value, 'Workspace query');
}

export function parseContextPack(value) {
  return parseProtocolValue(contextPackSchema, value, 'Context Pack');
}
