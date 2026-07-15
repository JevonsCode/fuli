import assert from 'node:assert/strict';
import test from 'node:test';

import * as protocol from '../src/workspace-protocol/index.js';

const publicProtocolSurface = [
  'FactCertainty',
  'FactState',
  'ProposalStatus',
  'ProtocolErrorCode',
  'ProtocolValidationError',
  'ProviderCapability',
  'WORKSPACE_PROTOCOL_VERSION',
  'WorkspaceRole',
  'WorkspaceVisibility',
  'contextPackSchema',
  'factProjectionSchema',
  'joinDecisionSchema',
  'joinRequestSchema',
  'parseContextPack',
  'parseJoinDecision',
  'parseJoinRequest',
  'parseProposalDecision',
  'parseProtocolValue',
  'parseProviderManifest',
  'parsePublicationProposal',
  'parsePublicationResult',
  'parseSyncPage',
  'parseWorkspaceDescriptor',
  'parseWorkspaceQuery',
  'proposalDecisionSchema',
  'protocolErrorResponseSchema',
  'providerManifestSchema',
  'publicationProposalSchema',
  'publicationResultSchema',
  'publicationSigningBytes',
  'sourceReferenceSchema',
  'syncPageSchema',
  'workspaceDescriptorSchema',
  'workspaceEventSchema',
  'workspaceQuerySchema',
];

test('workspace protocol exposes exactly the v1 public surface', () => {
  assert.deepEqual(Object.keys(protocol).sort(), publicProtocolSurface);
});

test('workspace protocol does not expose internal schema helpers', () => {
  for (const internalSymbol of [
    'idSchema',
    'cursorSchema',
    'revisionSchema',
    'timestampSchema',
    'sha256Schema',
    'sourceUriSchema',
    'createCanonicalBase64UrlSchema',
    'utf8JsonByteLength',
    'refineUtf8JsonByteBudget',
    'createNormalizedSemanticTextSchema',
    'createPreservedContentTextSchema',
    'createPreservedSemanticTextSchema',
    'rejectDuplicateValues',
  ]) {
    assert.equal(Object.hasOwn(protocol, internalSymbol), false, internalSymbol);
  }
});
