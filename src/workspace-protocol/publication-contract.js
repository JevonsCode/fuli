import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { canonicalJson } from '../publication/canonical-json.js';
import { rejectDuplicateValues } from './array-validation.js';
import { createCanonicalBase64UrlSchema } from './base64url-contract.js';
import {
  ProposalStatus,
  WORKSPACE_PROTOCOL_VERSION,
} from './constants.js';
import { sourceReferenceSchema } from './fact-contract.js';
import { refineUtf8JsonByteBudget } from './json-budget.js';
import {
  idSchema,
  revisionSchema,
  sourceUriSchema,
} from './scalar-contract.js';
import {
  createPreservedContentTextSchema,
  createPreservedSemanticTextSchema,
} from './text-contract.js';
import { parseProtocolValue } from './validation.js';

const MAX_PUBLICATION_PROPOSAL_BYTES = 1_048_576;
const PROJECTED_ZERO_SIGNATURE = Buffer.alloc(64).toString('base64url');
const changeOperationSchema = z.enum([
  'add',
  'supplement',
  'replace',
  'retract',
  'restore',
]);
const publicationSourceSchema = sourceReferenceSchema.extend({
  uri: sourceUriSchema,
});

const publicationChangeSchema = z
  .strictObject({
    clientFactId: idSchema,
    subject: createPreservedSemanticTextSchema(500),
    predicate: createPreservedSemanticTextSchema(160),
    object: createPreservedContentTextSchema(20_000),
    operation: changeOperationSchema,
    targetFactIds: z.array(idSchema).max(50),
  })
  .superRefine((change, context) => {
    rejectDuplicateValues(
      change.targetFactIds,
      context,
      (index) => ['targetFactIds', index],
    );

    if (change.operation === 'add' && change.targetFactIds.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['targetFactIds'],
        message: 'An add change cannot target an existing fact',
      });
    }

    if (change.operation !== 'add' && change.targetFactIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['targetFactIds'],
        message: 'This change operation requires an existing target fact',
      });
    }
  });

const unsignedPublicationProposalShape = {
  protocolVersion: z.literal(WORKSPACE_PROTOCOL_VERSION),
  publicationId: idSchema,
  idempotencyKey: createPreservedSemanticTextSchema(200),
  workspaceId: idSchema,
  source: publicationSourceSchema,
  changes: z.array(publicationChangeSchema).min(1).max(100),
  policyVersion: createPreservedSemanticTextSchema(32),
  signingKeyId: idSchema,
};

function refinePublicationProposal(proposal, context) {
  const clientFactIdValues = proposal.changes.map(
    ({ clientFactId }) => clientFactId,
  );
  const clientFactIds = new Set(clientFactIdValues);

  rejectDuplicateValues(
    clientFactIdValues,
    context,
    (index) => ['changes', index, 'clientFactId'],
  );

  const targetedFactIds = new Set();

  proposal.changes.forEach(({ targetFactIds }, changeIndex) => {
    const changeTargetFactIds = new Set();

    targetFactIds.forEach((targetFactId, targetIndex) => {
      const path = ['changes', changeIndex, 'targetFactIds', targetIndex];

      if (clientFactIds.has(targetFactId)) {
        context.addIssue({
          code: 'custom',
          path,
          message: 'An existing target cannot match a proposal client fact ID',
        });
      }

      if (targetedFactIds.has(targetFactId)) {
        context.addIssue({
          code: 'custom',
          path,
          message: 'An existing fact cannot be targeted by multiple changes',
        });
      }

      changeTargetFactIds.add(targetFactId);
    });

    changeTargetFactIds.forEach((targetFactId) => {
      targetedFactIds.add(targetFactId);
    });
  });

  const projectedProposal = 'signature' in proposal
    ? proposal
    : { ...proposal, signature: PROJECTED_ZERO_SIGNATURE };

  refineUtf8JsonByteBudget(
    projectedProposal,
    context,
    MAX_PUBLICATION_PROPOSAL_BYTES,
    'Publication proposal',
  );
}

const unsignedPublicationProposalSchema = z
  .strictObject(unsignedPublicationProposalShape)
  .superRefine(refinePublicationProposal);

export const publicationProposalSchema = z
  .strictObject({
    ...unsignedPublicationProposalShape,
    signature: createCanonicalBase64UrlSchema(64),
  })
  .superRefine(refinePublicationProposal);

export const publicationResultSchema = z
  .strictObject({
    proposalId: idSchema,
    status: z.enum(Object.values(ProposalStatus)),
    workspaceRevision: revisionSchema.nullable(),
    reason: createPreservedSemanticTextSchema(500).nullable(),
  })
  .superRefine((result, context) => {
    if (
      result.status === ProposalStatus.EFFECTIVE
      && result.workspaceRevision === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['workspaceRevision'],
        message: 'An effective proposal requires a workspace revision',
      });
    }

    if (
      result.status !== ProposalStatus.EFFECTIVE
      && result.workspaceRevision !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['workspaceRevision'],
        message: 'A non-effective proposal cannot have a workspace revision',
      });
    }

    if (result.status === ProposalStatus.REJECTED && result.reason === null) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A rejected proposal requires a reason',
      });
    }
  });

export function parsePublicationProposal(value) {
  return parseProtocolValue(
    publicationProposalSchema,
    value,
    'Publication proposal',
  );
}

export function parsePublicationResult(value) {
  return parseProtocolValue(
    publicationResultSchema,
    value,
    'Publication result',
  );
}

export function publicationSigningBytes(value) {
  const parsed = parseProtocolValue(
    unsignedPublicationProposalSchema,
    value,
    'Unsigned publication proposal',
  );

  return Buffer.from(canonicalJson(parsed), 'utf8');
}
