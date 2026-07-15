# Formal Local Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the temporary JSON runtime with the production local foundation for 复利: SQLite persistence, a stable application boundary, Personal Lens, privacy-safe publication outbox, and a real MCP server.

**Architecture:** A synchronous Store Port keeps domain services independent of persistence. `better-sqlite3` is the authoritative local store; the existing JSON store remains only as an import source and contract test adapter. Web, CLI, and MCP resolve the same application services, while public-bound facts leave the local runtime only as validated publication envelopes in an Outbox.

**Tech Stack:** Plain JavaScript ESM, Node.js 24+, `better-sqlite3` 12.x, `@modelcontextprotocol/sdk` 1.x, Zod 4.x, Node test runner.

---

## Scope Boundary

This plan implements the first formal subsystem defined in `docs/superpowers/specs/2026-07-10-compound-interest-design.md`.

Included:

- Production SQLite storage with versioned migrations and JSON import.
- Store Port coverage and removal of direct `store.data` reads.
- Personal Lens explicit memory, observation, correction, history, and bounded retrieval.
- Sensitive-content rejection and safe publication envelopes in an Outbox.
- Stable application services shared by Web, CLI, and MCP.
- Real MCP stdio tools, prompt, and resources.
- Minimal Web visibility for what Personal Lens currently knows.

Separate plans will connect the publication contract to the PostgreSQL shared-space service, Graphiti/Neo4j worker, remote sync, identity, and desktop packaging. Nothing in this plan may introduce an API that prevents those services from being added without rewriting the local domain.

## File Map

- `src/storage/store-port.js`: executable Store Port contract used by every adapter.
- `src/storage/file-store.js`: compatibility adapter for JSON import and contract tests.
- `src/storage/sqlite-store.js`: production SQLite adapter.
- `src/storage/migrations/001-initial.sql`: authoritative local schema.
- `src/storage/migrate.js`: migration runner.
- `src/storage/import-json.js`: idempotent legacy JSON importer.
- `src/app/create-application.js`: one composition root for Web, CLI, and MCP.
- `src/app/state-service.js`: state projections without adapter internals.
- `src/facts/fact-service.js`: fact creation, supersession, and history rules.
- `src/lens/lens-service.js`: explicit and observed Personal Lens writes and corrections.
- `src/lens/lens-query.js`: relevant, bounded Lens projection.
- `src/lens/interview-prompt.js`: reusable active interview prompt.
- `src/security/sensitive-content.js`: deterministic secret and restricted-content checks.
- `src/publication/publication-service.js`: validated publication envelope creation.
- `src/publication/outbox-service.js`: durable retry state transitions.
- `src/mcp/create-mcp-server.js`: official SDK adapter for tools, prompts, and resources.
- `src/mcp-server.js`: stdio process entrypoint and compatibility diagnostics.
- `src/runtime-options.js`: consistent database and active-personal-space resolution.
- `web/app.js`: render current Lens in the existing More drawer.

### Task 1: Pin Formal Runtime Dependencies

**Files:**
- Modify: `package.json`
- Create: `package-lock.json`
- Test: `test/runtime-dependencies.test.js`

- [ ] **Step 1: Write the failing dependency contract test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('formal runtime pins production storage and MCP dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.match(pkg.dependencies['better-sqlite3'], /^\^12\./);
  assert.match(pkg.dependencies['@modelcontextprotocol/sdk'], /^\^1\./);
  assert.match(pkg.dependencies.zod, /^\^4\./);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/runtime-dependencies.test.js`

Expected: FAIL because `package.json` has no `dependencies` object.

- [ ] **Step 3: Install the stable dependency lines**

Run:

```bash
npm install better-sqlite3@^12.11.1 @modelcontextprotocol/sdk@^1.29.0 zod@^4.4.3
```

Expected: `package.json` and `package-lock.json` record all three dependencies and installation exits 0.

- [ ] **Step 4: Verify GREEN and the existing suite**

Run: `node --test test/runtime-dependencies.test.js`

Expected: PASS.

Run: `node --test`

Expected: all existing tests and the dependency test pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json test/runtime-dependencies.test.js
git commit -m "build: add formal runtime dependencies"
```

### Task 2: Define the Store Port and Move the JSON Adapter

**Files:**
- Create: `src/storage/store-port.js`
- Create: `src/storage/file-store.js`
- Modify: `src/store.js`
- Test: `test/store-port.test.js`

- [ ] **Step 1: Write a failing Store Port test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertStorePort, STORE_METHODS } from '../src/storage/store-port.js';
import { FileStore } from '../src/store.js';

test('FileStore implements the complete Store Port', () => {
  const store = new FileStore(':memory:');
  assert.equal(assertStorePort(store), store);
  assert.ok(STORE_METHODS.includes('listSpaces'));
  assert.ok(STORE_METHODS.includes('getEpisode'));
  assert.ok(STORE_METHODS.includes('listFacts'));
  assert.ok(STORE_METHODS.includes('enqueueOutbox'));
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/store-port.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `store-port.js`.

- [ ] **Step 3: Add the executable contract**

```js
export const STORE_METHODS = Object.freeze([
  'transaction',
  'createSpace', 'listSpaces', 'findSpaceByName', 'getSpace',
  'subscribe', 'listSubscriptions', 'subscriptionsFor',
  'addEpisode', 'getEpisode', 'listEpisodes',
  'addFact', 'getFact', 'updateFact', 'invalidateFact',
  'currentFacts', 'listFacts', 'timeline', 'searchFacts',
  'addCandidate', 'getCandidate', 'listCandidates',
  'pendingCandidates', 'updateCandidateStatus',
  'enqueueOutbox', 'listPendingOutbox', 'markOutboxSent', 'markOutboxFailed',
  'hasImport', 'recordImport',
  'exportSnapshot', 'importSnapshot', 'close'
]);

export function assertStorePort(store) {
  const missing = STORE_METHODS.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) throw new TypeError(`Store Port missing: ${missing.join(', ')}`);
  return store;
}
```

Move the current implementation to `src/storage/file-store.js`, add the missing methods with array-backed behavior, and keep this compatibility export in `src/store.js`:

```js
export { FileStore } from './storage/file-store.js';
export { SqliteStore } from './storage/sqlite-store.js';
```

`transaction(fn)` snapshots the in-memory data, executes `fn(this)`, and restores the snapshot before rethrowing when `fn` fails. `close()` is a no-op, and `exportSnapshot()` returns a deep clone. Outbox rows use `{ id, kind, aggregateId, payload, status, attempts, nextAttemptAt, createdAt, sentAt, lastError }`. The compatibility adapter tracks import hashes in an `imports` array so it passes the same idempotency contract as SQLite.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/store-port.test.js test/store.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/storage/store-port.js src/storage/file-store.js test/store-port.test.js test/store.test.js
git commit -m "refactor: define local store port"
```

### Task 3: Add Versioned SQLite Schema and Adapter

**Files:**
- Create: `src/storage/migrations/001-initial.sql`
- Create: `src/storage/migrate.js`
- Create: `src/storage/sqlite-store.js`
- Test: `test/sqlite-store.test.js`
- Test: `test/store-contract.js`

- [ ] **Step 1: Write failing persistence and contract tests**

```js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SpaceKind } from '../src/models.js';
import { SqliteStore } from '../src/storage/sqlite-store.js';

test('SqliteStore migrates and persists spaces across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-sqlite-'));
  const path = join(dir, 'context.db');
  const first = new SqliteStore(path);
  const space = first.createSpace('我', SpaceKind.PERSONAL);
  first.close();

  const second = new SqliteStore(path);
  assert.equal(second.getSpace(space.id).name, '我');
  assert.deepEqual(second.schemaVersions(), [1]);
  second.close();
  rmSync(dir, { recursive: true, force: true });
});
```

Add `test/store-contract.js` exporting `runStoreContract(name, createStore)` and cover spaces, subscriptions, episodes, facts, candidate transitions, search, timeline, Outbox transitions, snapshot export/import, and transaction rollback. Invoke the suite for both `FileStore` and `SqliteStore`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/sqlite-store.test.js`

Expected: FAIL because `sqlite-store.js` does not exist.

- [ ] **Step 3: Create the complete initial migration**

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'public')),
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  personal_space_id TEXT NOT NULL REFERENCES spaces(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  mode TEXT NOT NULL DEFAULT 'latest',
  created_at TEXT NOT NULL,
  PRIMARY KEY (personal_space_id, space_id)
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  source_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  source_uri TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_episode_id TEXT NOT NULL REFERENCES episodes(id),
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  scope TEXT NOT NULL DEFAULT 'personal',
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  replaced_by_fact_id TEXT REFERENCES facts(id)
);

CREATE INDEX facts_current_idx ON facts(space_id, predicate, invalid_at);
CREATE INDEX facts_source_idx ON facts(source_episode_id);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  personal_space_id TEXT NOT NULL REFERENCES spaces(id),
  target_space_id TEXT REFERENCES spaces(id),
  episode_id TEXT NOT NULL REFERENCES episodes(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX outbox_pending_idx ON outbox(status, next_attempt_at, created_at);

CREATE TABLE imports (
  content_hash TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement migration runner and prepared-statement adapter**

`runMigrations(db)` must load ordered `*.sql` files, execute each unapplied migration and its `schema_migrations` insert in one transaction, enable WAL for file databases, set `foreign_keys=ON`, and set `busy_timeout=5000`.

`SqliteStore` must:

```js
export class SqliteStore {
  constructor(filePath = '.fuli/context.db') {
    this.db = new Database(filePath);
    configureDatabase(this.db, filePath);
    runMigrations(this.db);
  }

  transaction(fn) {
    return this.db.transaction(() => fn(this))();
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
```

Implement every Store Port method with prepared statements. Convert snake_case database rows to the existing camelCase domain shape at the adapter boundary. Serialize only `metadata` and `payload` as JSON.

- [ ] **Step 5: Verify GREEN and parity**

Run: `node --test test/sqlite-store.test.js test/store-port.test.js test/store.test.js`

Expected: both adapters pass the same contract.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/001-initial.sql src/storage/migrate.js src/storage/sqlite-store.js test/sqlite-store.test.js test/store-contract.js test/store-port.test.js
git commit -m "feat: add production sqlite store"
```

### Task 4: Import Existing JSON Without Losing History

**Files:**
- Create: `src/storage/import-json.js`
- Modify: `src/cli.js`
- Test: `test/import-json.test.js`
- Test: `test/cli.test.js`

- [ ] **Step 1: Write failing import tests**

```js
test('legacy JSON import preserves ids, timestamps, replacements, and is idempotent', () => {
  const source = createLegacyFixture();
  const store = new SqliteStore(':memory:');
  const first = importJsonSnapshot(store, source, 'legacy.json');
  const second = importJsonSnapshot(store, source, 'legacy.json');
  assert.equal(first.imported, true);
  assert.equal(second.imported, false);
  assert.equal(store.listSpaces().length, source.spaces.length);
  assert.equal(store.listFacts({ includeHistorical: true })[0].replacedByFactId, 'fact-new');
});
```

Add a CLI test for:

```bash
node src/cli.js migrate --from context.json --to context.db
```

Expected JSON output contains `{ "imported": true }`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/import-json.test.js test/cli.test.js`

Expected: FAIL because `importJsonSnapshot` and `migrate` do not exist.

- [ ] **Step 3: Implement a validated, transactional importer**

```js
export function importJsonSnapshot(store, snapshot, sourcePath = '<memory>') {
  const normalized = validateLegacySnapshot(snapshot);
  const contentHash = createHash('sha256').update(stableJson(normalized)).digest('hex');
  if (store.hasImport(contentHash)) return { imported: false, contentHash };
  store.transaction(() => {
    store.importSnapshot(normalized);
    store.recordImport({ contentHash, sourcePath, importedAt: nowIso() });
  });
  return { imported: true, contentHash };
}
```

Validation must require arrays for `spaces`, `subscriptions`, `episodes`, `facts`, and `candidates`; verify referenced IDs before writing; preserve IDs and all historical timestamps; and reject malformed JSON before opening a write transaction.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/import-json.test.js test/cli.test.js`

Expected: PASS, including the second no-op import.

- [ ] **Step 5: Commit**

```bash
git add src/storage/import-json.js src/cli.js test/import-json.test.js test/cli.test.js
git commit -m "feat: import legacy json into sqlite"
```

### Task 5: Remove Adapter Internals From Domain and HTTP State

**Files:**
- Create: `src/app/create-application.js`
- Create: `src/app/state-service.js`
- Create: `src/facts/fact-service.js`
- Modify: `src/ingestion.js`
- Modify: `src/router.js`
- Modify: `src/candidates.js`
- Modify: `src/server.js`
- Test: `test/application.test.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Add a failing no-internals application test**

```js
test('application services work through Store Port without a data property', () => {
  const store = hideAdapterInternals(new FileStore(':memory:'));
  const app = createApplication({ store });
  const { personal, project } = app.bootstrap();
  app.remember({
    personalSpaceId: personal.id,
    targetSpaceId: project.id,
    sourceKind: 'prd',
    body: 'api_base: https://api.example.com'
  });
  assert.equal(app.state().currentFacts.length, 1);
});
```

`hideAdapterInternals` delegates only Store Port methods and intentionally exposes no `.data`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/application.test.js`

Expected: FAIL where current services read `store.data`.

- [ ] **Step 3: Extract fact rules and compose one application**

`FactService` owns duplicate prevention, unique-parameter supersession, replacement, and fact status transitions. `IngestionService` calls it rather than implementing those rules privately.

```js
export function createApplication({ store, activePersonalSpaceName = '我' }) {
  assertStorePort(store);
  const facts = new FactService(store);
  const ingestion = new IngestionService(store, { facts });
  const context = new ContextRouter(store);
  const state = new StateService(store);
  const requireActivePersonalSpace = () => {
    const space = store.findSpaceByName(activePersonalSpaceName);
    if (!space || space.kind !== 'personal') {
      throw new Error(`Active personal space not found: ${activePersonalSpaceName}`);
    }
    return space;
  };
  return {
    store,
    bootstrap: () => bootstrapStarterSpaces(store),
    remember: input => ingestion.remember(input),
    search: input => context.searchContext(input),
    state: () => state.build(),
    close: () => store.close(),
    requireActivePersonalSpace
  };
}
```

Replace all `store.data.*` reads with `listSpaces`, `listSubscriptions`, `listEpisodes`, `listFacts`, and `getEpisode`. HTTP handlers receive `app`, not individual services.

- [ ] **Step 4: Prove adapter internals are gone**

Run: `rg "store\.data" src`

Expected: no matches.

Run: `node --test test/application.test.js test/server.test.js test/ingestion.test.js test/router.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app src/facts src/ingestion.js src/router.js src/candidates.js src/server.js test/application.test.js test/server.test.js test/ingestion.test.js test/router.test.js
git commit -m "refactor: compose domain through store port"
```

### Task 6: Implement Personal Lens Writes and Human-Controlled Status

**Files:**
- Modify: `src/models.js`
- Create: `src/lens/lens-service.js`
- Create: `src/security/sensitive-content.js`
- Modify: `src/app/create-application.js`
- Test: `test/lens-service.test.js`
- Test: `test/sensitive-content.test.js`

- [ ] **Step 1: Write failing Lens behavior tests**

```js
test('explicit user fact is confirmed and keeps its source episode', () => {
  const result = lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我更熟悉 JavaScript',
    sourceKind: 'conversation'
  });
  assert.equal(result.fact.status, 'confirmed');
  assert.equal(store.getEpisode(result.fact.sourceEpisodeId).body, '我更熟悉 JavaScript');
});

test('inferred observation is suggested and cannot self-confirm', () => {
  const result = lens.submitUserObservation({
    personalSpaceId: personal.id,
    predicate: 'prefers_minimal_ui',
    value: 'true',
    evidenceText: '用户连续要求减少界面元素',
    inference: 'inferred'
  });
  assert.equal(result.fact.status, 'suggested');
});

test('credentials are rejected before an episode is stored', () => {
  assert.throws(() => lens.rememberUserFact({
    personalSpaceId: personal.id,
    predicate: 'credential',
    value: 'sk-live-12345678901234567890',
    sourceText: '记住 sk-live-12345678901234567890'
  }), /sensitive content/i);
  assert.equal(store.listEpisodes().length, 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/lens-service.test.js test/sensitive-content.test.js`

Expected: FAIL because LensService and the sensitive detector do not exist.

- [ ] **Step 3: Add explicit statuses and deterministic rejection**

Add `Sensitivity` (`normal`, `private`, `restricted`) and `FactScope` (`personal`, `public`) constants. Keep existing status strings stable.

`detectSensitiveContent(text)` must detect private-key headers, common API key prefixes, bearer tokens, JWTs, and password/secret assignments. It returns `{ restricted, reasons }` without logging the matched secret.

`LensService` rules:

```js
const status = inference === 'inferred' ? FactStatus.SUGGESTED :
  inference === 'direct' ? FactStatus.OBSERVED : FactStatus.CONFIRMED;
```

Every Lens fact uses `scope: personal`. Only `confirmObservation({ personalSpaceId, factId, sourceText })` may change `observed` or `suggested` to `confirmed`, and it must create a confirmation Episode.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/lens-service.test.js test/sensitive-content.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/models.js src/lens/lens-service.js src/security/sensitive-content.js src/app/create-application.js test/lens-service.test.js test/sensitive-content.test.js
git commit -m "feat: add source-backed personal lens"
```

### Task 7: Implement Corrections, History, and Bounded Lens Retrieval

**Files:**
- Create: `src/lens/lens-query.js`
- Modify: `src/lens/lens-service.js`
- Modify: `src/app/create-application.js`
- Test: `test/lens-query.test.js`

- [ ] **Step 1: Write failing correction and budget tests**

```js
test('correction replaces the current fact and preserves old history', () => {
  const oldFact = rememberConfirmed('prefers_language', 'JavaScript');
  const result = lens.correctUserFact({
    personalSpaceId: personal.id,
    factId: oldFact.id,
    action: 'replace',
    value: 'TypeScript',
    sourceText: '现在更偏好 TypeScript'
  });
  assert.equal(store.getFact(oldFact.id).replacedByFactId, result.fact.id);
  assert.equal(store.getFact(oldFact.id).invalidAt !== null, true);
  assert.equal(store.currentFacts(personal.id)[0].object, 'TypeScript');
});

test('getUserLens respects the byte-conservative token budget', () => {
  seedLensFacts(30);
  const result = query.getUserLens({
    personalSpaceId: personal.id,
    task: '前端 JavaScript 架构',
    budget: 160,
    includeObserved: true,
    includeSuggested: false
  });
  assert.ok(Buffer.byteLength(result.text, 'utf8') <= 160);
  assert.equal(result.facts.some(fact => fact.status === 'suggested'), false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/lens-query.test.js`

Expected: FAIL because correction and query APIs are missing.

- [ ] **Step 3: Implement correction actions and deterministic ranking**

Supported actions are exactly `replace`, `reject`, and `deprecate`.

- `replace`: create a new fact from a correction Episode, then invalidate the old fact with `replacedByFactId`.
- `reject`: set status `rejected`, set `invalidAt`, and keep the correction Episode as evidence.
- `deprecate`: set status `deprecated`, set `invalidAt`, and keep the reason.

`LensQuery` ranks current facts by: boundary predicates first; exact task term matches; confirmed before observed; recency; stable ID. Suggested facts are excluded unless explicitly requested. Build output one complete line at a time and stop before UTF-8 byte length exceeds `budget`, which is a conservative cross-model token ceiling.

Return:

```js
{
  personalSpaceId,
  task,
  text,
  facts,
  estimatedTokens: Buffer.byteLength(text, 'utf8'),
  truncated
}
```

`searchUserContext({ personalSpaceId, query, includeHistorical = false })` returns matching Lens facts with source Episodes and replacement metadata. It never returns non-personal spaces. `createApplication` exposes one `app.lens` facade containing `rememberUserFact`, `submitUserObservation`, `correctUserFact`, `confirmObservation`, `getUserLens`, and `searchUserContext`, so adapters never assemble Lens behavior themselves.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/lens-query.test.js test/lens-service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lens/lens-query.js src/lens/lens-service.js src/app/create-application.js test/lens-query.test.js test/lens-service.test.js
git commit -m "feat: query and correct personal lens"
```

### Task 8: Create Safe Publication Envelopes and Durable Outbox

**Files:**
- Create: `src/publication/publication-service.js`
- Create: `src/publication/outbox-service.js`
- Modify: `src/ingestion.js`
- Modify: `src/app/create-application.js`
- Test: `test/publication-service.test.js`
- Test: `test/outbox-service.test.js`

- [ ] **Step 1: Write failing privacy-boundary tests**

```js
test('confirmed public project fact becomes a content-addressed publication envelope', () => {
  const result = publication.prepare({
    spaceId: project.id,
    episode,
    facts: [publicFact]
  });
  assert.equal(result.envelope.spaceId, project.id);
  assert.match(result.envelope.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(store.listPendingOutbox().length, 1);
});

test('personal lens facts can never enter a publication envelope', () => {
  assert.throws(() => publication.prepare({
    spaceId: project.id,
    episode,
    facts: [{ ...lensFact, scope: 'personal' }]
  }), /personal fact/i);
  assert.equal(store.listPendingOutbox().length, 0);
});
```

Add tests rejecting restricted content, missing source episodes, non-public target spaces, unconfirmed inferred facts, and tampered hashes.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/publication-service.test.js test/outbox-service.test.js`

Expected: FAIL because publication services do not exist.

- [ ] **Step 3: Implement canonical envelope validation**

```js
const envelopeBody = {
  id: randomUUID(),
  spaceId,
  source: {
    episodeId: episode.id,
    kind: episode.sourceKind,
    uri: episode.sourceUri,
    capturedAt: episode.createdAt
  },
  facts: facts.map(toPublishableFact),
  policyVersion: '1'
};
const contentHash = sha256(stableJson(envelopeBody));
const envelope = { ...envelopeBody, contentHash };
```

`prepare` validates every fact before opening the transaction, then enqueues one `publication` Outbox row atomically. `verify(envelope)` recalculates the canonical hash and rejects modified content. `OutboxService.markFailed(id, error)` stores a sanitized error string, increments attempts, and calculates capped exponential retry delays of 1, 2, 4, 8, 16, then 30 minutes. It never stores stack traces or secrets.

Update public ingestion so safe project facts create an Outbox envelope after local confirmation. Personal and candidate routes never invoke publication.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/publication-service.test.js test/outbox-service.test.js test/ingestion.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/publication src/ingestion.js src/app/create-application.js test/publication-service.test.js test/outbox-service.test.js test/ingestion.test.js
git commit -m "feat: add privacy-safe publication outbox"
```

### Task 9: Extend the Stable Agent Tool Registry

**Files:**
- Modify: `src/agent-tools.js`
- Modify: `src/app/create-application.js`
- Test: `test/agent-tools.test.js`

- [ ] **Step 1: Add failing tool contract tests**

```js
test('agent tools expose Personal Lens without exposing the store', () => {
  const names = listAgentTools().map(tool => tool.name);
  assert.ok(names.includes('remember_user_fact'));
  assert.ok(names.includes('submit_user_observation'));
  assert.ok(names.includes('correct_user_fact'));
  assert.ok(names.includes('confirm_observation'));
  assert.ok(names.includes('get_user_lens'));
  assert.ok(names.includes('search_user_context'));
});
```

Add one execution test per tool, including a rejected secret and a suggested inference excluded from the default Lens.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/agent-tools.test.js`

Expected: FAIL because the six Personal Lens tools are absent.

- [ ] **Step 3: Route all tools through the application object**

Change `callAgentTool` to accept `app`, not `store`. Keep existing tool names and JSON schemas stable. For Personal Lens tools, resolve `personalSpaceId` as `input.personalSpaceId ?? app.requireActivePersonalSpace().id`, then dispatch:

```js
const withPersonalSpace = input => ({
  ...input,
  personalSpaceId: input.personalSpaceId ?? app.requireActivePersonalSpace().id
});

const personalLensTools = {
  remember_user_fact: input => app.lens.rememberUserFact(withPersonalSpace(input)),
  submit_user_observation: input => app.lens.submitUserObservation(withPersonalSpace(input)),
  correct_user_fact: input => app.lens.correctUserFact(withPersonalSpace(input)),
  confirm_observation: input => app.lens.confirmObservation(withPersonalSpace(input)),
  get_user_lens: input => app.lens.getUserLens(withPersonalSpace(input)),
  search_user_context: input => app.lens.searchUserContext(withPersonalSpace(input))
};
```

`confirm_observation` requires `factId` and `sourceText`, creates the confirmation Episode, and is the only Agent tool that can promote `observed` or `suggested` Lens facts to `confirmed`. Each result returns source-backed structured data. No result includes `store`, database paths, or a full snapshot.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/agent-tools.test.js test/mcp-server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent-tools.js src/app/create-application.js test/agent-tools.test.js test/mcp-server.test.js
git commit -m "feat: expose personal lens agent tools"
```

### Task 10: Replace the MCP Seam With a Real stdio Server

**Files:**
- Create: `src/mcp/create-mcp-server.js`
- Modify: `src/mcp-server.js`
- Test: `test/mcp-integration.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write a failing protocol-level integration test**

Use the official SDK client and `StdioClientTransport` to spawn:

```js
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp-server.js', '--db', dbPath, '--personal-space', '我'],
  cwd: projectRoot
});
const client = new Client({ name: 'fuli-test', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
assert.ok(tools.tools.some(tool => tool.name === 'get_user_lens'));
const result = await client.callTool({
  name: 'remember_user_fact',
  arguments: {
    predicate: 'prefers_language',
    value: 'JavaScript',
    sourceText: '我熟悉 JavaScript'
  }
});
assert.equal(result.isError, undefined);
await client.close();
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/mcp-integration.test.js`

Expected: FAIL because the current process exits instead of speaking MCP.

- [ ] **Step 3: Register tools with the official stable SDK**

Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, and Zod 4 schemas. Register read-only/destructive/idempotent annotations accurately. Convert application results to both `structuredContent` and compact text content. Tool errors return `isError: true` with sanitized messages.

Set MCP server instructions that tell Agents to query `get_user_lens` when personal context can materially change a task, call `remember_user_fact` for durable preferences the user explicitly states during ordinary work, and call `submit_user_observation` for inferred patterns. This passive growth behavior must not require the user to invoke the interview prompt, and inferred observations must never be self-confirmed.

`src/mcp-server.js` behavior:

- `--tools` and `--call` remain compatibility diagnostics and use the same application.
- Default mode opens SQLite, resolves the active personal space, connects stdio, and writes no non-protocol output to stdout.
- Diagnostics go to stderr.
- SIGINT and SIGTERM close MCP and SQLite exactly once.

Add package script:

```json
"mcp": "node src/mcp-server.js"
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/mcp-integration.test.js test/mcp-server.test.js`

Expected: PASS with a real initialize/listTools/callTool exchange.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/create-mcp-server.js src/mcp-server.js test/mcp-integration.test.js test/mcp-server.test.js package.json package-lock.json
git commit -m "feat: serve fuli over standard mcp"
```

### Task 11: Add the Active Interview Prompt and Lens Resources

**Files:**
- Create: `src/lens/interview-prompt.js`
- Modify: `src/mcp/create-mcp-server.js`
- Test: `test/mcp-lens-surfaces.test.js`

- [ ] **Step 1: Write failing prompt and resource tests**

```js
const prompts = await client.listPrompts();
assert.ok(prompts.prompts.some(prompt => prompt.name === 'get_to_know_me'));

const prompt = await client.getPrompt({ name: 'get_to_know_me', arguments: {} });
assert.match(prompt.messages[0].content.text, /一次只问一个问题/);
assert.match(prompt.messages[0].content.text, /get_user_lens/);

const resource = await client.readResource({ uri: 'fuli://lens/current' });
const body = JSON.parse(resource.contents[0].text);
assert.equal(body.personalSpaceId, personal.id);
assert.equal('snapshot' in body, false);
```

Also cover `fuli://lens/history` and `fuli://spaces/subscribed`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/mcp-lens-surfaces.test.js`

Expected: FAIL because prompts and resources are not registered.

- [ ] **Step 3: Implement the reusable interview prompt**

The prompt must instruct the Agent to:

1. Call `get_user_lens` with task `认识用户并补足稳定、跨项目偏好`.
2. Summarize known confirmed facts and mark observed uncertainty.
3. Ask only missing domains in order: communication, tone, structure, technical depth, learning preference, quality priorities, collaboration style, environment, boundaries.
4. Ask one question at a time and allow skipping.
5. Call `remember_user_fact` only for explicit answers.
6. Call `submit_user_observation` for inferences, never self-confirm them.
7. Avoid credentials, exact addresses, health data, and other restricted content.
8. Recap additions and invite corrections.

Resources resolve against the configured active personal space and return JSON projections only. History is capped at 100 facts and includes replacement/source metadata.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/mcp-lens-surfaces.test.js test/mcp-integration.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lens/interview-prompt.js src/mcp/create-mcp-server.js test/mcp-lens-surfaces.test.js
git commit -m "feat: add get-to-know-me mcp surfaces"
```

### Task 12: Make SQLite the Default Runtime Across Web and CLI

**Files:**
- Create: `src/runtime-options.js`
- Modify: `src/server.js`
- Modify: `src/cli.js`
- Delete: `src/adapters/graphiti.js`
- Modify: `README.md`
- Test: `test/runtime-options.test.js`
- Test: `test/server.test.js`
- Test: `test/cli.test.js`

- [ ] **Step 1: Write failing default-runtime tests**

```js
test('default runtime path is a SQLite database in .fuli', () => {
  assert.equal(resolveDbPath([]), '.fuli/context.db');
});

test('json paths are rejected as live runtime databases', () => {
  assert.throws(() => resolveStore({ dbPath: '.fuli/context.json' }), /migrate/i);
});
```

Add Web and CLI tests proving both surfaces persist into the same temporary `.db` and reopen successfully.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/runtime-options.test.js test/server.test.js test/cli.test.js`

Expected: FAIL because defaults still use JSON.

- [ ] **Step 3: Centralize runtime creation**

`resolveRuntimeOptions(args, env)` resolves:

```js
{
  dbPath: option(args, '--db') ?? env.FULI_DB_PATH ?? '.fuli/context.db',
  personalSpaceName: option(args, '--personal-space') ?? env.FULI_PERSONAL_SPACE ?? '我'
}
```

Reject `.json` in live mode with the exact migration command. Tests may still instantiate `FileStore(':memory:')` directly. Web and CLI call `createApplication({ store: new SqliteStore(dbPath), activePersonalSpaceName: personalSpaceName })`, run bootstrap before serving requests, and close it on shutdown. Remove the local `GraphitiAdapter` stub; Graphiti belongs to the later shared-space projection worker and must not remain as a misleading local design seam.

Update README run commands to `.fuli/context.db`, document the one-time JSON import command, and include Codex/Claude stdio MCP configuration examples.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/runtime-options.test.js test/server.test.js test/cli.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime-options.js src/server.js src/cli.js src/adapters/graphiti.js README.md test/runtime-options.test.js test/server.test.js test/cli.test.js
git commit -m "feat: make sqlite the default local runtime"
```

### Task 13: Show Personal Lens Without Adding a New Primary Workflow

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `src/server.js`
- Test: `test/web.test.js`
- Test: `test/server.test.js`

- [ ] **Step 1: Write failing minimal-UI tests**

```js
test('workbench keeps three primary entries and tucks Personal Lens under More', () => {
  assert.equal((html.match(/data-primary-action=/g) ?? []).length, 3);
  assert.match(html, /id="lens-section"/);
  assert.match(html, />关于我</);
  assert.doesNotMatch(html, /用户画像/);
});
```

Add an API test for `GET /api/lens?personalSpaceId=personal-123&budget=1200` that returns current source-backed Lens facts without historical or suggested facts by default.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/web.test.js test/server.test.js`

Expected: FAIL because the Lens section and API are missing.

- [ ] **Step 3: Add a collapsed About Me projection**

Inside the existing More drawer, add one collapsed `details` section titled `关于我`. Render concise current facts with human labels for confirmed and observed status. Each row includes a small source/time line. Do not add onboarding copy, a dashboard, a graph, a new primary tab, or an always-visible profile card.

The API calls `app.lens.getUserLens` and never returns `exportSnapshot()`.

- [ ] **Step 4: Verify behavior and layout**

Run: `node --test test/web.test.js test/server.test.js`

Expected: PASS.

Start the server with a temporary database, inspect desktop and 375px mobile widths, and verify no overlap, horizontal scrolling, or console errors. This historical UI requirement was superseded by the federated local-console design on 2026-07-11.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js web/styles.css src/server.js test/web.test.js test/server.test.js
git commit -m "feat: reveal personal lens quietly"
```

### Task 14: Final Formal-Runtime Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-10-compound-interest-design.md`
- Test: all tests

- [ ] **Step 1: Run the complete automated suite**

Run: `node --test`

Expected: 0 failures, 0 skipped tests, and no experimental warnings.

- [ ] **Step 2: Audit architectural invariants**

Run: `rg "store\.data|context\.json|MCP support is optional|GraphitiAdapter is a design seam" src web README.md`

Expected: no production-path matches. A legacy migration example may mention `context.json` only as an input to `fuli migrate`.

Run: `rg "FileStore" src`

Expected: only the compatibility export/import path; server, CLI, MCP, and composition root use `SqliteStore`.

- [ ] **Step 3: Verify persistence, MCP, and privacy end to end**

Run a temporary runtime and perform this sequence:

1. Start Web with a new `.db` and confirm starter spaces exist.
2. Store an explicit user preference through MCP.
3. Read it through `fuli://lens/current`.
4. Submit an inferred preference and confirm it is absent from default Lens.
5. Correct the explicit preference and confirm the old value appears only in history.
6. Store a public project parameter and confirm one publication envelope is pending.
7. Attempt to store a key-like secret and confirm no Episode, Fact, or Outbox row is created.
8. Stop and reopen the runtime and confirm every accepted state persists.

Expected: all eight checks pass and the browser console contains no errors.

- [ ] **Step 4: Update the design implementation status**

Add a dated implementation-status section to the design spec listing the completed formal-runtime capabilities and naming the next independent plan: PostgreSQL shared-space service plus Graphiti/Neo4j projection worker.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-07-10-compound-interest-design.md
git commit -m "docs: mark formal local runtime implemented"
```

- [ ] **Step 6: Final verification**

Run: `git status --short`

Expected: no output.

Run: `node --test`

Expected: 0 failures.
