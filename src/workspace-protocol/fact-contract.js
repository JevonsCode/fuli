import { z } from 'zod';

import { rejectDuplicateValues } from './array-validation.js';
import { FactCertainty, FactState } from './constants.js';
import {
  idSchema,
  revisionSchema,
  sha256Schema,
  sourceUriSchema,
  timestampSchema,
} from './scalar-contract.js';
import {
  createPreservedContentTextSchema,
  createPreservedSemanticTextSchema,
} from './text-contract.js';

export const sourceReferenceSchema = z.strictObject({
  episodeId: idSchema,
  kind: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
  uri: sourceUriSchema.nullable(),
  capturedAt: timestampSchema,
  contentHash: sha256Schema,
});

export const factProjectionSchema = z
  .strictObject({
    id: idSchema,
    subject: createPreservedSemanticTextSchema(500),
    predicate: createPreservedSemanticTextSchema(160),
    object: createPreservedContentTextSchema(20_000),
    state: z.enum(Object.values(FactState)),
    certainty: z.enum(Object.values(FactCertainty)),
    validFrom: timestampSchema,
    validTo: timestampSchema.nullable(),
    recordedAt: timestampSchema,
    revision: revisionSchema,
    sources: z.array(sourceReferenceSchema).min(1).max(20),
    replaces: z.array(idSchema).max(50),
    replacedBy: z.array(idSchema).max(50),
  })
  .superRefine((fact, context) => {
    rejectDuplicateValues(
      fact.sources.map(({ episodeId }) => episodeId),
      context,
      (index) => ['sources', index, 'episodeId'],
    );
    rejectDuplicateValues(
      fact.replaces,
      context,
      (index) => ['replaces', index],
    );
    rejectDuplicateValues(
      fact.replacedBy,
      context,
      (index) => ['replacedBy', index],
    );

    fact.replaces.forEach((id, index) => {
      if (id === fact.id) {
        context.addIssue({
          code: 'custom',
          path: ['replaces', index],
          message: 'A fact cannot replace itself',
        });
      }
    });

    const replacedIds = new Set(fact.replaces);

    fact.replacedBy.forEach((id, index) => {
      if (id === fact.id) {
        context.addIssue({
          code: 'custom',
          path: ['replacedBy', index],
          message: 'A fact cannot be replaced by itself',
        });
      }

      if (replacedIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['replacedBy', index],
          message: 'Replacement relationships cannot overlap',
        });
      }
    });

    if (
      fact.validTo !== null
      && Date.parse(fact.validTo) < Date.parse(fact.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'validTo cannot be earlier than validFrom',
      });
    }

    const recordedAtEpoch = Date.parse(fact.recordedAt);

    fact.sources.forEach(({ capturedAt }, index) => {
      if (Date.parse(capturedAt) > recordedAtEpoch) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'capturedAt'],
          message: 'Source capture time cannot follow fact recording time',
        });
      }
    });
  });
