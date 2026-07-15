import { z } from 'zod';

import { canonicalJson } from '../publication/canonical-json.js';
import {
  ProposalStatus,
  WorkspaceRole,
  WorkspaceVisibility,
} from './constants.js';
import { refineUtf8JsonByteBudget } from './json-budget.js';
import {
  cursorSchema,
  idSchema,
  revisionSchema,
  timestampSchema,
} from './scalar-contract.js';
import { parseProtocolValue } from './validation.js';

const MAX_SYNC_EVENTS = 500;
const MAX_SYNC_PAGE_BYTES = 1_048_576;

function createWorkspaceEventSchema(type, data) {
  return z.strictObject({
    eventId: idSchema,
    workspaceRevision: revisionSchema,
    recordedAt: timestampSchema,
    type: z.literal(type),
    data,
  });
}

const workspaceUpdatedEventSchema = createWorkspaceEventSchema(
  'workspace.updated',
  z.strictObject({
    visibility: z.enum(Object.values(WorkspaceVisibility)),
  }),
);

const membershipChangedEventSchema = createWorkspaceEventSchema(
  'membership.changed',
  z.strictObject({
    subjectId: idSchema,
    role: z.enum(Object.values(WorkspaceRole)).nullable(),
  }),
);

const episodeRecordedEventSchema = createWorkspaceEventSchema(
  'episode.recorded',
  z.strictObject({ episodeId: idSchema }),
);

const factActivatedEventSchema = createWorkspaceEventSchema(
  'fact.activated',
  z.strictObject({ factId: idSchema }),
);

const factSupersededEventSchema = createWorkspaceEventSchema(
  'fact.superseded',
  z
    .strictObject({
      factId: idSchema,
      replacedByFactId: idSchema,
    })
    .superRefine((data, context) => {
      if (data.factId === data.replacedByFactId) {
        context.addIssue({
          code: 'custom',
          path: ['replacedByFactId'],
          message: 'A fact cannot supersede itself',
        });
      }
    }),
);

const factRetractedEventSchema = createWorkspaceEventSchema(
  'fact.retracted',
  z.strictObject({ factId: idSchema }),
);

const proposalPendingEventSchema = createWorkspaceEventSchema(
  'proposal.pending',
  z.strictObject({ proposalId: idSchema }),
);

const proposalDecidedEventSchema = createWorkspaceEventSchema(
  'proposal.decided',
  z.strictObject({
    proposalId: idSchema,
    status: z.enum([
      ProposalStatus.EFFECTIVE,
      ProposalStatus.REJECTED,
    ]),
  }),
);

const signingKeyRevokedEventSchema = createWorkspaceEventSchema(
  'signing_key.revoked',
  z.strictObject({ keyId: idSchema }),
);

export const workspaceEventSchema = z.discriminatedUnion('type', [
  workspaceUpdatedEventSchema,
  membershipChangedEventSchema,
  episodeRecordedEventSchema,
  factActivatedEventSchema,
  factSupersededEventSchema,
  factRetractedEventSchema,
  proposalPendingEventSchema,
  proposalDecidedEventSchema,
  signingKeyRevokedEventSchema,
]);

export const syncPageSchema = z
  .strictObject({
    workspaceId: idSchema,
    events: z.array(workspaceEventSchema).max(MAX_SYNC_EVENTS),
    nextCursor: cursorSchema.nullable(),
    hasMore: z.boolean(),
  })
  .superRefine((page, context) => {
    const fingerprintsByEventId = new Map();
    let previousUniqueRevision;

    page.events.forEach((workspaceEvent, index) => {
      const fingerprint = canonicalJson(workspaceEvent);
      const previousFingerprint = fingerprintsByEventId.get(
        workspaceEvent.eventId,
      );

      if (previousFingerprint !== undefined) {
        if (previousFingerprint !== fingerprint) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'eventId'],
            message: 'An event ID cannot identify conflicting events',
          });
        }

        return;
      }

      fingerprintsByEventId.set(workspaceEvent.eventId, fingerprint);
      const currentRevision = BigInt(workspaceEvent.workspaceRevision);

      if (
        previousUniqueRevision !== undefined
        && currentRevision < previousUniqueRevision
      ) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'workspaceRevision'],
          message: 'Workspace revisions must be nondecreasing',
        });
      }

      previousUniqueRevision = currentRevision;
    });

    if (page.hasMore && page.events.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['events'],
        message: 'A continued Sync page requires at least one event',
      });
    }

    if (page.hasMore && page.nextCursor === null) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'A continued Sync page requires a next cursor',
      });
    }

    refineUtf8JsonByteBudget(
      page,
      context,
      MAX_SYNC_PAGE_BYTES,
      'Sync page',
    );
  });

export function parseSyncPage(value) {
  return parseProtocolValue(syncPageSchema, value, 'Sync page');
}
