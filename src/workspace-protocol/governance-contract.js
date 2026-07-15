import { z } from 'zod';

import { idSchema, timestampSchema } from './scalar-contract.js';
import { createPreservedSemanticTextSchema } from './text-contract.js';
import { parseProtocolValue } from './validation.js';

const semanticGovernanceTextSchema = createPreservedSemanticTextSchema(500);

export const joinRequestSchema = z.strictObject({
  requestId: idSchema,
  workspaceId: idSchema,
  requesterId: idSchema,
  message: semanticGovernanceTextSchema.nullable(),
  createdAt: timestampSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
});

export const joinDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  reason: semanticGovernanceTextSchema,
});

export const proposalDecisionSchema = z.strictObject({
  decision: z.enum([
    'accept_new',
    'keep_current',
    'keep_both',
    'request_source',
  ]),
  reason: semanticGovernanceTextSchema,
});

export function parseJoinRequest(value) {
  return parseProtocolValue(joinRequestSchema, value, 'Join request');
}

export function parseJoinDecision(value) {
  return parseProtocolValue(joinDecisionSchema, value, 'Join decision');
}

export function parseProposalDecision(value) {
  return parseProtocolValue(
    proposalDecisionSchema,
    value,
    'Proposal decision',
  );
}
