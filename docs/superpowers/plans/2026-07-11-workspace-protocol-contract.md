# Workspace Protocol Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stable, strict JavaScript contract for Fuli Workspace Protocol v1 so the local runtime, official Provider, and self-hosted Providers exchange the same bounded and testable payloads.

**Architecture:** A transport-neutral `src/workspace-protocol` package owns version constants, strict Zod schemas, canonical publication signing payloads, and stable error codes. It does not know HTTP, PostgreSQL, OpenFGA, Graphiti, or the local Store Port; those adapters consume the contract in later plans.

**Tech Stack:** Plain JavaScript ESM, Node.js 24+, Zod 4.x, existing canonical JSON/SHA-256 helper, Node test runner.

---

## Scope Boundary

Included:

- Provider discovery Manifest and workspace descriptor contracts.
- Bounded query request and source-backed Fact Context Pack contracts.
- Signed publication proposal and result contracts.
- Incremental sync event/page contracts.
- Join request and human decision contracts.
- Stable protocol error body and one public export surface.

Not included:

- HTTP routes, OIDC, OpenFGA, PostgreSQL, local Provider registry or Outbox delivery.
- Cryptographic key storage or signature verification against a registered actor key.
- Graphiti projection and either frontend.

The next plan consumes these schemas in the PostgreSQL Workspace Provider. No later adapter may redefine wire payloads independently.

## File Map

- `src/workspace-protocol/constants.js`: protocol versions, capabilities, visibility, roles and status enums.
- `src/workspace-protocol/validation.js`: one strict parse helper with bounded validation errors.
- `src/workspace-protocol/error-contract.js`: stable machine error codes and response schema.
- `src/workspace-protocol/manifest-contract.js`: Provider Manifest and workspace descriptor.
- `src/workspace-protocol/fact-contract.js`: shared Fact, source and replacement projections.
- `src/workspace-protocol/query-contract.js`: structured query and Context Pack.
- `src/workspace-protocol/publication-contract.js`: signed proposal, canonical signing input and result.
- `src/workspace-protocol/sync-contract.js`: discriminated incremental events and sync page.
- `src/workspace-protocol/governance-contract.js`: join requests and human decisions.
- `src/workspace-protocol/index.js`: the only supported import surface.
- `test/workspace-protocol-*.test.js`: focused contract tests by capability.

### Task 1: Add Protocol Constants, Strict Validation and Error Contract

**Files:**
- Create: `src/workspace-protocol/constants.js`
- Create: `src/workspace-protocol/validation.js`
- Create: `src/workspace-protocol/error-contract.js`
- Create: `test/workspace-protocol-foundation.test.js`

- [ ] **Step 1: Write the failing foundation test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProtocolErrorCode,
  ProtocolValidationError,
  WorkspaceVisibility,
  parseProtocolValue,
  protocolErrorResponseSchema
} from '../src/workspace-protocol/index.js';

test('protocol constants are immutable and errors have a strict bounded body', () => {
  assert.equal(Object.isFrozen(WorkspaceVisibility), true);
  assert.deepEqual(Object.values(WorkspaceVisibility), ['public', 'unlisted', 'private']);
  const body = parseProtocolValue(protocolErrorResponseSchema, {
    code: ProtocolErrorCode.VALIDATION_FAILED,
    message: 'workspaceId is required',
    traceId: 'trace-1'
  }, 'Protocol error');
  assert.equal(body.code, 'VALIDATION_FAILED');
  assert.throws(
    () => parseProtocolValue(protocolErrorResponseSchema, { ...body, stack: 'private' }, 'Protocol error'),
    ProtocolValidationError
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/workspace-protocol-foundation.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `workspace-protocol/index.js`.

- [ ] **Step 3: Implement constants and strict parsing**

Create `constants.js` with frozen values:

```js
export const WORKSPACE_PROTOCOL_VERSION = '1';
export const ProviderCapability = Object.freeze({
  QUERY: 'query', SYNC: 'sync', PUBLISH: 'publish', REVIEW: 'review'
});
export const WorkspaceVisibility = Object.freeze({
  PUBLIC: 'public', UNLISTED: 'unlisted', PRIVATE: 'private'
});
export const WorkspaceRole = Object.freeze({ MEMBER: 'member', MAINTAINER: 'maintainer' });
export const ProposalStatus = Object.freeze({
  EFFECTIVE: 'effective', PENDING_REVIEW: 'pending_review', REJECTED: 'rejected'
});
export const FactState = Object.freeze({
  ACTIVE: 'active', SUPERSEDED: 'superseded', RETRACTED: 'retracted', DISPUTED: 'disputed'
});
export const FactCertainty = Object.freeze({
  CONFIRMED: 'confirmed', KNOWN_UNKNOWN: 'known_unknown'
});
```

Create `validation.js`:

```js
export class ProtocolValidationError extends TypeError {
  constructor(label, issues) {
    super(`${label} failed protocol validation`);
    this.name = 'ProtocolValidationError';
    this.issues = issues.slice(0, 20).map(({ code, path, message }) => ({ code, path, message }));
  }
}

export function parseProtocolValue(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolValidationError(label, result.error.issues);
  return result.data;
}
```

Create `error-contract.js`:

```js
import { z } from 'zod';

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
  PROTOCOL_INCOMPATIBLE: 'PROTOCOL_INCOMPATIBLE'
});

export const protocolErrorResponseSchema = z.strictObject({
  code: z.enum(Object.values(ProtocolErrorCode)),
  message: z.string().min(1).max(500),
  traceId: z.string().min(1).max(128),
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional()
});
```

Create a temporary `index.js` exporting these modules; later tasks extend it.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/workspace-protocol-foundation.test.js`

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-protocol test/workspace-protocol-foundation.test.js
git commit -m "feat: define workspace protocol foundation"
```

### Task 2: Define Provider Discovery and Workspace Descriptors

**Files:**
- Create: `src/workspace-protocol/manifest-contract.js`
- Modify: `src/workspace-protocol/index.js`
- Create: `test/workspace-protocol-manifest.test.js`

- [ ] **Step 1: Write failing Manifest tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseProviderManifest, parseWorkspaceDescriptor } from '../src/workspace-protocol/index.js';

const manifest = {
  providerId: 'acme-knowledge',
  displayName: 'Acme Knowledge',
  protocolVersions: ['1'],
  apiBaseUrl: 'https://knowledge.acme.test/api/fuli/v1',
  webBaseUrl: 'https://knowledge.acme.test',
  oidc: { issuer: 'https://id.acme.test', audience: 'fuli-workspace' },
  capabilities: ['query', 'sync', 'publish', 'review'],
  signingKeys: [{ keyId: 'provider-2026-07', algorithm: 'EdDSA', publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } }]
};

test('Provider Manifest accepts one HTTPS origin and supported protocol version', () => {
  assert.equal(parseProviderManifest(manifest).providerId, 'acme-knowledge');
  assert.throws(() => parseProviderManifest({ ...manifest, apiBaseUrl: 'http://knowledge.acme.test' }));
  assert.throws(() => parseProviderManifest({ ...manifest, capabilities: ['query', 'root'] }));
});

test('workspace descriptor is strict and revision is serialized as a decimal string', () => {
  const value = parseWorkspaceDescriptor({
    id: 'ws-1', slug: 'payments', name: '支付平台', description: null,
    visibility: 'public', role: null, revision: '42', updatedAt: '2026-07-11T00:00:00.000Z'
  });
  assert.equal(value.revision, '42');
  assert.throws(() => parseWorkspaceDescriptor({ ...value, secret: true }));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/workspace-protocol-manifest.test.js`

Expected: FAIL because the parser exports do not exist.

- [ ] **Step 3: Implement strict discovery schemas**

Create `manifest-contract.js`:

```js
import { z } from 'zod';
import { ProviderCapability, WorkspaceRole, WorkspaceVisibility } from './constants.js';
import { parseProtocolValue } from './validation.js';

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS URL required');
const isoTimestamp = z.iso.datetime({ offset: true });
const decimalRevision = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20);
const publicJwkSchema = z.strictObject({
  kty: z.string().min(1).max(16), crv: z.string().min(1).max(32), x: z.string().min(1).max(256)
});

export const providerManifestSchema = z.strictObject({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().min(1).max(100),
  protocolVersions: z.array(z.literal('1')).min(1).max(4),
  apiBaseUrl: httpsUrl,
  webBaseUrl: httpsUrl,
  oidc: z.strictObject({ issuer: httpsUrl, audience: z.string().min(1).max(200) }),
  capabilities: z.array(z.enum(Object.values(ProviderCapability))).min(1).max(8),
  signingKeys: z.array(z.strictObject({
    keyId: z.string().min(1).max(128), algorithm: z.literal('EdDSA'), publicJwk: publicJwkSchema
  })).max(8)
});

export const workspaceDescriptorSchema = z.strictObject({
  id: z.string().min(1).max(128),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  visibility: z.enum(Object.values(WorkspaceVisibility)),
  role: z.enum(Object.values(WorkspaceRole)).nullable(),
  revision: decimalRevision,
  updatedAt: isoTimestamp
});

export const parseProviderManifest = (value) => parseProtocolValue(providerManifestSchema, value, 'Provider Manifest');
export const parseWorkspaceDescriptor = (value) => parseProtocolValue(workspaceDescriptorSchema, value, 'Workspace descriptor');
```

Export the schemas and parsers from `index.js`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/workspace-protocol-manifest.test.js`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-protocol/manifest-contract.js src/workspace-protocol/index.js test/workspace-protocol-manifest.test.js
git commit -m "feat: add provider discovery contract"
```

### Task 3: Define Source-Backed Fact Query Contracts

**Files:**
- Create: `src/workspace-protocol/fact-contract.js`
- Create: `src/workspace-protocol/query-contract.js`
- Modify: `src/workspace-protocol/index.js`
- Create: `test/workspace-protocol-query.test.js`

- [ ] **Step 1: Write failing bounded-query tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseContextPack, parseWorkspaceQuery } from '../src/workspace-protocol/index.js';

test('query input is structured, bounded and has safe defaults', () => {
  const query = parseWorkspaceQuery({ text: 'test callback', predicates: ['callback_url'] });
  assert.deepEqual(
    { includeHistory: query.includeHistory, limit: query.limit },
    { includeHistory: false, limit: 20 }
  );
  assert.throws(() => parseWorkspaceQuery({ text: 'x'.repeat(513) }));
  assert.throws(() => parseWorkspaceQuery({ text: 'ok', personalLens: [] }));
});

test('Context Pack always carries sources, replacement links and freshness', () => {
  const pack = parseContextPack({
    workspaceId: 'ws-1', workspaceRevision: '7', generatedAt: '2026-07-11T00:00:00.000Z',
    freshness: { state: 'fresh', lastSyncedAt: '2026-07-11T00:00:00.000Z' },
    facts: [{
      id: 'fact-2', subject: '支付平台', predicate: 'callback_url', object: 'https://test.example/callback',
      state: 'active', certainty: 'confirmed', validFrom: '2026-07-11T00:00:00.000Z', validTo: null,
      recordedAt: '2026-07-11T00:00:00.000Z', revision: '7',
      sources: [{ episodeId: 'ep-1', kind: 'prd', uri: 'prd://7', capturedAt: '2026-07-11T00:00:00.000Z', contentHash: 'a'.repeat(64) }],
      replaces: ['fact-1'], replacedBy: []
    }],
    nextCursor: null, truncated: false
  });
  assert.equal(pack.facts[0].sources[0].episodeId, 'ep-1');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/workspace-protocol-query.test.js`

Expected: FAIL because query parsers do not exist.

- [ ] **Step 3: Implement shared Fact and query contracts**

Create `fact-contract.js`:

```js
import { z } from 'zod';
import { FactCertainty, FactState } from './constants.js';

export const idSchema = z.string().min(1).max(128);
export const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20);
export const timestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const sourceReferenceSchema = z.strictObject({
  episodeId: idSchema,
  kind: z.string().min(1).max(64),
  uri: z.string().max(2048).nullable(),
  capturedAt: timestampSchema,
  contentHash: sha256Schema
});

export const factProjectionSchema = z.strictObject({
  id: idSchema,
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(160),
  object: z.string().max(20_000),
  state: z.enum(Object.values(FactState)),
  certainty: z.enum(Object.values(FactCertainty)),
  validFrom: timestampSchema,
  validTo: timestampSchema.nullable(),
  recordedAt: timestampSchema,
  revision: revisionSchema,
  sources: z.array(sourceReferenceSchema).min(1).max(20),
  replaces: z.array(idSchema).max(50),
  replacedBy: z.array(idSchema).max(50)
});
```

Create `query-contract.js`:

```js
import { z } from 'zod';
import { factProjectionSchema, idSchema, revisionSchema, timestampSchema } from './fact-contract.js';
import { parseProtocolValue } from './validation.js';

export const workspaceQuerySchema = z.strictObject({
  text: z.string().min(1).max(512).optional(),
  subjects: z.array(z.string().min(1).max(500)).max(20).default([]),
  predicates: z.array(z.string().min(1).max(160)).max(20).default([]),
  factIds: z.array(idSchema).max(50).default([]),
  asOf: timestampSchema.optional(),
  includeHistory: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).nullable().default(null)
}).refine((value) => value.text || value.subjects.length || value.predicates.length || value.factIds.length, {
  message: 'At least one query selector is required'
});

export const contextPackSchema = z.strictObject({
  workspaceId: idSchema,
  workspaceRevision: revisionSchema,
  generatedAt: timestampSchema,
  freshness: z.strictObject({ state: z.enum(['fresh', 'stale']), lastSyncedAt: timestampSchema }),
  facts: z.array(factProjectionSchema).max(100),
  nextCursor: z.string().min(1).max(512).nullable(),
  truncated: z.boolean()
});

export const parseWorkspaceQuery = (value) => parseProtocolValue(workspaceQuerySchema, value, 'Workspace query');
export const parseContextPack = (value) => parseProtocolValue(contextPackSchema, value, 'Context Pack');
```

Export both modules from `index.js`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/workspace-protocol-query.test.js`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-protocol test/workspace-protocol-query.test.js
git commit -m "feat: define workspace query contract"
```

### Task 4: Define Canonical Signed Publication Proposals

**Files:**
- Create: `src/workspace-protocol/publication-contract.js`
- Modify: `src/workspace-protocol/index.js`
- Create: `test/workspace-protocol-publication.test.js`

- [ ] **Step 1: Write failing publication canonicalization tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePublicationProposal,
  parsePublicationResult,
  publicationSigningBytes
} from '../src/workspace-protocol/index.js';

const proposal = {
  protocolVersion: '1', publicationId: 'pub-1', idempotencyKey: 'capture:ep-1', workspaceId: 'ws-1',
  source: { episodeId: 'ep-1', kind: 'prd', uri: 'prd://7', capturedAt: '2026-07-11T00:00:00.000Z', contentHash: 'a'.repeat(64) },
  changes: [{ clientFactId: 'local-fact-1', subject: '支付平台', predicate: 'callback_url', object: 'https://test.example/callback', operation: 'add', targetFactIds: [] }],
  policyVersion: '1', signingKeyId: 'device-1', signature: 'YWJj'
};

test('publication signing bytes exclude only the signature and are key-order stable', () => {
  const parsed = parsePublicationProposal(proposal);
  const reordered = Object.fromEntries(Object.entries(proposal).reverse());
  assert.deepEqual(publicationSigningBytes(parsed), publicationSigningBytes(parsePublicationProposal(reordered)));
  assert.equal(publicationSigningBytes(parsed).includes('YWJj'), false);
});

test('publication changes require targets for destructive operations', () => {
  assert.throws(() => parsePublicationProposal({
    ...proposal,
    changes: [{ ...proposal.changes[0], operation: 'replace', targetFactIds: [] }]
  }));
  assert.equal(parsePublicationResult({ proposalId: 'pub-1', status: 'effective', workspaceRevision: '8', reason: null }).status, 'effective');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/workspace-protocol-publication.test.js`

Expected: FAIL because publication parsers do not exist.

- [ ] **Step 3: Implement the strict signed proposal contract**

Create `publication-contract.js`:

```js
import { z } from 'zod';
import { canonicalJson } from '../publication/canonical-json.js';
import { ProposalStatus, WORKSPACE_PROTOCOL_VERSION } from './constants.js';
import { idSchema, revisionSchema, sourceReferenceSchema } from './fact-contract.js';
import { parseProtocolValue } from './validation.js';

const operationSchema = z.enum(['add', 'supplement', 'replace', 'retract', 'restore']);
const changeSchema = z.strictObject({
  clientFactId: idSchema,
  subject: z.string().min(1).max(500),
  predicate: z.string().min(1).max(160),
  object: z.string().max(20_000),
  operation: operationSchema,
  targetFactIds: z.array(idSchema).max(50)
}).superRefine((change, context) => {
  const requiresTarget = ['supplement', 'replace', 'retract', 'restore'].includes(change.operation);
  if (requiresTarget && change.targetFactIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['targetFactIds'], message: `${change.operation} requires a target fact` });
  }
  if (change.operation === 'add' && change.targetFactIds.length !== 0) {
    context.addIssue({ code: 'custom', path: ['targetFactIds'], message: 'add cannot target an existing fact' });
  }
});

export const publicationProposalSchema = z.strictObject({
  protocolVersion: z.literal(WORKSPACE_PROTOCOL_VERSION),
  publicationId: idSchema,
  idempotencyKey: z.string().min(1).max(200),
  workspaceId: idSchema,
  source: sourceReferenceSchema,
  changes: z.array(changeSchema).min(1).max(100),
  policyVersion: z.string().min(1).max(32),
  signingKeyId: idSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]+$/).max(1024)
});

export const publicationResultSchema = z.strictObject({
  proposalId: idSchema,
  status: z.enum(Object.values(ProposalStatus)),
  workspaceRevision: revisionSchema.nullable(),
  reason: z.string().min(1).max(500).nullable()
});

export const parsePublicationProposal = (value) => parseProtocolValue(publicationProposalSchema, value, 'Publication proposal');
export const parsePublicationResult = (value) => parseProtocolValue(publicationResultSchema, value, 'Publication result');
export function publicationSigningBytes(proposal) {
  const parsed = parsePublicationProposal(proposal);
  const { signature: _signature, ...signed } = parsed;
  return Buffer.from(canonicalJson(signed), 'utf8');
}
```

Export the module from `index.js`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/workspace-protocol-publication.test.js`

Expected: 2 tests pass.

- [ ] **Step 5: Run existing publication regression tests**

Run: `node --test test/publication-service.test.js test/sensitive-content.test.js test/secret-metadata-boundary.test.js`

Expected: all tests pass; the new wire contract does not weaken the existing local publication boundary.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-protocol test/workspace-protocol-publication.test.js
git commit -m "feat: define signed publication proposal contract"
```

### Task 5: Define Incremental Sync and Governance Contracts

**Files:**
- Create: `src/workspace-protocol/sync-contract.js`
- Create: `src/workspace-protocol/governance-contract.js`
- Modify: `src/workspace-protocol/index.js`
- Create: `test/workspace-protocol-sync.test.js`
- Create: `test/workspace-protocol-governance.test.js`

- [ ] **Step 1: Write failing sync and governance tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJoinDecision, parseSyncPage, parseProposalDecision } from '../src/workspace-protocol/index.js';

test('sync page uses discriminated bounded events and an opaque cursor', () => {
  const page = parseSyncPage({
    workspaceId: 'ws-1',
    events: [{ eventId: 'evt-1', type: 'fact.activated', workspaceRevision: '9', recordedAt: '2026-07-11T00:00:00.000Z', data: { factId: 'fact-1' } }],
    nextCursor: 'opaque-2', hasMore: false
  });
  assert.equal(page.events[0].type, 'fact.activated');
  assert.throws(() => parseSyncPage({ ...page, events: [{ ...page.events[0], data: { privateBody: 'leak' } }] }));
});

test('human decisions are a small explicit choice set with a reason', () => {
  assert.equal(parseJoinDecision({ decision: 'approve', reason: 'works on payments' }).decision, 'approve');
  assert.equal(parseProposalDecision({ decision: 'keep_both', reason: 'environment-specific values' }).decision, 'keep_both');
  assert.throws(() => parseProposalDecision({ decision: 'let_ai_decide', reason: 'fast' }));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/workspace-protocol-sync.test.js test/workspace-protocol-governance.test.js`

Expected: FAIL because sync and governance parsers do not exist.

- [ ] **Step 3: Implement discriminated sync events**

Create `sync-contract.js`:

```js
import { z } from 'zod';
import { ProposalStatus, WorkspaceRole, WorkspaceVisibility } from './constants.js';
import { idSchema, revisionSchema, timestampSchema } from './fact-contract.js';
import { parseProtocolValue } from './validation.js';

const base = { eventId: idSchema, workspaceRevision: revisionSchema, recordedAt: timestampSchema };
const event = (type, data) => z.strictObject({ ...base, type: z.literal(type), data });
export const workspaceEventSchema = z.discriminatedUnion('type', [
  event('workspace.updated', z.strictObject({ visibility: z.enum(Object.values(WorkspaceVisibility)) })),
  event('membership.changed', z.strictObject({ subjectId: idSchema, role: z.enum(Object.values(WorkspaceRole)).nullable() })),
  event('episode.recorded', z.strictObject({ episodeId: idSchema })),
  event('fact.activated', z.strictObject({ factId: idSchema })),
  event('fact.superseded', z.strictObject({ factId: idSchema, replacedByFactId: idSchema })),
  event('fact.retracted', z.strictObject({ factId: idSchema })),
  event('proposal.pending', z.strictObject({ proposalId: idSchema })),
  event('proposal.decided', z.strictObject({ proposalId: idSchema, status: z.enum(Object.values(ProposalStatus)) })),
  event('signing_key.revoked', z.strictObject({ keyId: idSchema }))
]);

export const syncPageSchema = z.strictObject({
  workspaceId: idSchema,
  events: z.array(workspaceEventSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
  hasMore: z.boolean()
});
export const parseSyncPage = (value) => parseProtocolValue(syncPageSchema, value, 'Sync page');
```

- [ ] **Step 4: Implement bounded governance choices**

Create `governance-contract.js`:

```js
import { z } from 'zod';
import { idSchema, timestampSchema } from './fact-contract.js';
import { parseProtocolValue } from './validation.js';

const reason = z.string().min(1).max(500);
export const joinRequestSchema = z.strictObject({
  requestId: idSchema, workspaceId: idSchema, requesterId: idSchema,
  message: z.string().max(500).nullable(), createdAt: timestampSchema,
  status: z.enum(['pending', 'approved', 'rejected'])
});
export const joinDecisionSchema = z.strictObject({ decision: z.enum(['approve', 'reject']), reason });
export const proposalDecisionSchema = z.strictObject({
  decision: z.enum(['accept_new', 'keep_current', 'keep_both', 'request_source']), reason
});
export const parseJoinRequest = (value) => parseProtocolValue(joinRequestSchema, value, 'Join request');
export const parseJoinDecision = (value) => parseProtocolValue(joinDecisionSchema, value, 'Join decision');
export const parseProposalDecision = (value) => parseProtocolValue(proposalDecisionSchema, value, 'Proposal decision');
```

Export both modules from `index.js`.

- [ ] **Step 5: Run and verify GREEN**

Run: `node --test test/workspace-protocol-sync.test.js test/workspace-protocol-governance.test.js`

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-protocol test/workspace-protocol-sync.test.js test/workspace-protocol-governance.test.js
git commit -m "feat: define sync and governance contracts"
```

### Task 6: Lock the Public Export Surface and Verify the Complete Contract

**Files:**
- Modify: `src/workspace-protocol/index.js`
- Create: `test/workspace-protocol-surface.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write the failing export-surface test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import * as protocol from '../src/workspace-protocol/index.js';

test('Workspace Protocol exposes one intentional adapter-facing surface', () => {
  assert.deepEqual(Object.keys(protocol).sort(), [
    'FactCertainty', 'FactState', 'ProposalStatus', 'ProtocolErrorCode',
    'ProtocolValidationError', 'ProviderCapability', 'WORKSPACE_PROTOCOL_VERSION',
    'WorkspaceRole', 'WorkspaceVisibility', 'contextPackSchema', 'factProjectionSchema',
    'joinDecisionSchema', 'joinRequestSchema', 'parseContextPack', 'parseJoinDecision',
    'parseJoinRequest', 'parseProposalDecision', 'parseProviderManifest',
    'parseProtocolValue', 'parsePublicationProposal', 'parsePublicationResult',
    'parseSyncPage', 'parseWorkspaceDescriptor', 'parseWorkspaceQuery',
    'proposalDecisionSchema', 'protocolErrorResponseSchema', 'providerManifestSchema',
    'publicationProposalSchema', 'publicationResultSchema', 'publicationSigningBytes',
    'sourceReferenceSchema', 'syncPageSchema', 'workspaceDescriptorSchema',
    'workspaceEventSchema', 'workspaceQuerySchema'
  ]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/workspace-protocol-surface.test.js`

Expected: FAIL with a concrete missing or extra export list.

- [ ] **Step 3: Make `index.js` the complete explicit surface**

Use named exports only; do not use `export *`. Export exactly the symbols asserted by the test so adding a wire capability requires an intentional contract review.

- [ ] **Step 4: Document the contract boundary**

Add a `Workspace Protocol` section to `README.md` stating:

```markdown
## Workspace Protocol

`src/workspace-protocol/index.js` is the transport-neutral Fuli Workspace Protocol v1 contract. Provider and local adapters must parse every inbound and outbound payload through these strict schemas. The contract carries bounded facts, sources, history links, freshness, idempotency and human decisions; it never carries Personal Lens or complete local conversations.
```

- [ ] **Step 5: Run focused and full verification**

Run: `node --test test/workspace-protocol-*.test.js`

Expected: all Workspace Protocol tests pass.

Run: `npm test`

Expected: all existing 420 tests plus the new protocol tests pass.

Run: `git diff --check`

Expected: no output and exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-protocol test/workspace-protocol-*.test.js README.md
git commit -m "docs: expose workspace protocol v1 contract"
```

## Plan Self-Review

- Spec coverage: this plan covers the complete transport contract required by design sections 5 and 6, plus the visibility, role, proposal and decision vocabulary consumed by sections 7 through 9.
- Deliberate gaps: Provider persistence, authentication, authorization, HTTP delivery, local sync, UI and graph projection each remain separate implementation plans because they are independently testable subsystems.
- Privacy: no contract accepts Personal Lens, raw conversation, local paths, credentials or unrestricted metadata. Source URI is bounded but still requires the existing local source-metadata policy before publication.
- Type consistency: IDs, decimal revisions, ISO timestamps, visibility, role, Fact status and Proposal status share one definition across all contracts.
- No placeholders: every task names exact files, tests, commands, expected failures, implementation contents and commit boundaries.
