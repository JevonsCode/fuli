# MVP Local Context Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable JavaScript MVP that can create personal/public spaces, ingest work episodes, classify content into personal/public/candidate paths, preserve current and historical facts, and expose query tools for agents.

**Architecture:** The MVP uses plain JavaScript modules with a small domain core, a file-backed local store, an ingestion service, a context router, a CLI, and an optional MCP server seam. The store interface is intentionally shaped so SQLite and Graphiti can replace the local JSON backend without rewriting product logic.

**Tech Stack:** Node.js 24+, plain JavaScript, Node built-in `node:test`, JSON file store for MVP persistence, optional future `@modelcontextprotocol/sdk`, future Graphiti adapter.

---

## File Structure

- Create: `package.json`  
  Project metadata, CLI bin, test script, ESM config.

- Modify: `README.md`  
  MVP usage, philosophy, commands, and Graphiti/local-store boundary.

- Create: `src/models.js`  
  Constants and helpers for Space, Subscription, Episode, Fact, Candidate, routes, and statuses.

- Create: `src/store.js`  
  File-backed repository for spaces, subscriptions, episodes, facts, and candidates.

- Create: `src/classifier.js`  
  Deterministic privacy/publish classifier for safe MVP automatic routing.

- Create: `src/extractor.js`  
  Minimal deterministic fact extractor for key/value lines, URLs, forbidden methods, and replacement lines.

- Create: `src/ingestion.js`  
  Ingestion service that writes episode, extracts facts, applies classifier, publishes public facts, and queues uncertain candidates.

- Create: `src/router.js`  
  Context router that searches a personal space and subscribed spaces, defaulting to current facts.

- Create: `src/cli.js`  
  CLI for space create, subscribe, remember, search, timeline, and candidates.

- Create: `src/mcp-server.js`  
  Optional MCP tools: remember_episode, search_context, get_current_facts, get_timeline.

- Create: `src/adapters/graphiti.js`  
  Graphiti adapter seam documenting how the local model maps to Graphiti concepts.

- Create: `test/models.test.js`  
  Model helper tests.

- Create: `test/store.test.js`  
  Repository behavior tests.

- Create: `test/classifier-extractor.test.js`  
  Publish/privacy classifier and extractor tests.

- Create: `test/ingestion.test.js`  
  Ingestion and temporal replacement tests.

- Create: `test/router.test.js`  
  Personal + subscribed public context routing tests.

- Create: `test/cli.test.js`  
  Smoke test for CLI commands.

## Task 1: JavaScript Project Skeleton

**Files:**
- Create: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Create package metadata**

Create `package.json` with ESM, test script, and CLI bin.

- [ ] **Step 2: Update README**

Document the MVP loop and explicitly say the MVP uses a JSON file store as a local executable backend, while Graphiti remains the intended temporal knowledge graph adapter.

- [ ] **Step 3: Run baseline test command**

Run: `node --test`

Expected: no tests found or no failures.

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json README.md docs/superpowers/specs/2026-07-10-compound-interest-design.md docs/superpowers/plans/2026-07-10-mvp-local-context-loop.md
git commit -m "chore: switch MVP plan to JavaScript"
```

## Task 2: Domain Models

**Files:**
- Create: `src/models.js`
- Test: `test/models.test.js`

- [ ] **Step 1: Write failing tests**

Test stable enum values and `isCurrentFact`.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/models.test.js`

Expected: FAIL because `src/models.js` does not exist.

- [ ] **Step 3: Implement models**

Export:

- `SpaceKind`
- `CandidateStatus`
- `FactStatus`
- `PublishRoute`
- `isCurrentFact(fact)`
- `nowIso()`

- [ ] **Step 4: Run tests**

Run: `node --test test/models.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/models.js test/models.test.js
git commit -m "feat: add core domain model helpers"
```

## Task 3: File Store

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

- [ ] **Step 1: Write failing repository tests**

Test create space, subscribe, add episode, add fact, invalidate fact, current facts, timeline, and text search.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/store.test.js`

Expected: FAIL because `src/store.js` does not exist.

- [ ] **Step 3: Implement `FileStore`**

Persist a JSON object:

```js
{
  spaces: [],
  subscriptions: [],
  episodes: [],
  facts: [],
  candidates: []
}
```

Methods:

- `createSpace(name, kind, description)`
- `findSpaceByName(name)`
- `getSpace(id)`
- `subscribe(personalSpaceId, spaceId, mode)`
- `subscriptionsFor(personalSpaceId)`
- `addEpisode(spaceId, sourceKind, body, sourceUri)`
- `addFact(fact)`
- `invalidateFact(factId, replacedByFactId)`
- `currentFacts(spaceId)`
- `timeline(spaceId, subject)`
- `searchFacts(spaceIds, query, { includeHistorical })`
- `addCandidate(candidate)`
- `pendingCandidates(personalSpaceId)`

- [ ] **Step 4: Run repository tests**

Run: `node --test test/store.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/store.js test/store.test.js
git commit -m "feat: add file-backed temporal store"
```

## Task 4: Classifier and Extractor

**Files:**
- Create: `src/classifier.js`
- Create: `src/extractor.js`
- Test: `test/classifier-extractor.test.js`

- [ ] **Step 1: Write failing tests**

Test public PRD facts, personal preference routing, candidate routing, key/value extraction, forbidden method extraction, and replacement extraction.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/classifier-extractor.test.js`

Expected: FAIL because classifier and extractor do not exist.

- [ ] **Step 3: Implement classifier**

Routes:

- `public` when source kind is `prd`, `git`, `config`, or `docs`, body has fact-like syntax, and no personal markers.
- `personal` when body contains first-person or preference/judgment markers.
- `candidate` otherwise.

- [ ] **Step 4: Implement extractor**

Support:

- `key: value` -> `has_key`
- URLs -> `has_url`
- `禁止: value` -> `forbids`
- `替代: old => new` -> replacement spec

- [ ] **Step 5: Run tests**

Run: `node --test test/classifier-extractor.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/classifier.js src/extractor.js test/classifier-extractor.test.js
git commit -m "feat: classify and extract MVP facts"
```

## Task 5: Ingestion Service

**Files:**
- Create: `src/ingestion.js`
- Test: `test/ingestion.test.js`

- [ ] **Step 1: Write failing tests**

Test personal route, public route, candidate route, and replacement invalidating old public facts.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/ingestion.test.js`

Expected: FAIL because `src/ingestion.js` does not exist.

- [ ] **Step 3: Implement ingestion**

`remember({ personalSpaceId, sourceKind, body, targetSpaceId, sourceUri })` should:

1. Always write raw episode to personal space first.
2. Classify the body.
3. If route is personal, extract facts into personal space.
4. If route is public and target space exists, write public episode and facts to target space.
5. If route is candidate, add a quiet candidate.
6. Handle replacements by invalidating matching current facts and adding the new fact.

- [ ] **Step 4: Run ingestion tests**

Run: `node --test test/ingestion.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/ingestion.js test/ingestion.test.js
git commit -m "feat: add automatic context ingestion"
```

## Task 6: Context Router

**Files:**
- Create: `src/router.js`
- Test: `test/router.test.js`

- [ ] **Step 1: Write failing tests**

Test that a personal search includes subscribed public spaces and defaults to current facts.

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/router.test.js`

Expected: FAIL because `src/router.js` does not exist.

- [ ] **Step 3: Implement router**

`searchContext({ personalSpaceId, query, includeHistorical })` should search personal and subscribed spaces, return facts and a compact answer string.

- [ ] **Step 4: Run router tests**

Run: `node --test test/router.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/router.js test/router.test.js
git commit -m "feat: route context across subscribed spaces"
```

## Task 7: CLI

**Files:**
- Create: `src/cli.js`
- Test: `test/cli.test.js`

- [ ] **Step 1: Write failing CLI smoke test**

Use `node src/cli.js --db <tmp> ...` to create spaces, subscribe, remember a PRD fact, and search.

- [ ] **Step 2: Run CLI test to verify failure**

Run: `node --test test/cli.test.js`

Expected: FAIL because CLI does not exist.

- [ ] **Step 3: Implement CLI**

Commands:

- `space create NAME --kind personal|public`
- `subscribe PERSONAL_SPACE PUBLIC_SPACE`
- `remember PERSONAL_SPACE --target SPACE --source-kind prd --text TEXT`
- `search PERSONAL_SPACE QUERY`
- `timeline SPACE SUBJECT`
- `candidates PERSONAL_SPACE`

- [ ] **Step 4: Run CLI tests**

Run: `node --test test/cli.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat: add local fuli CLI"
```

## Task 8: MCP and Graphiti Seams

**Files:**
- Create: `src/mcp-server.js`
- Create: `src/adapters/graphiti.js`

- [ ] **Step 1: Implement optional MCP server seam**

Use dynamic import for `@modelcontextprotocol/sdk` and show a clear install message if missing.

- [ ] **Step 2: Implement Graphiti adapter seam**

Document mappings:

- Space -> Graphiti `group_id`
- Episode -> Graphiti episode
- Fact -> Graphiti edge/fact with valid/invalid time
- Candidate -> stays outside Graphiti until confirmed or safely published

Runtime methods should raise `NotImplementedError`-style errors in MVP.

- [ ] **Step 3: Run import smoke check**

Run: `node src/mcp-server.js --help`

Expected without optional dependency: clear message telling user MCP is optional.

- [ ] **Step 4: Commit**

Run:

```bash
git add src/mcp-server.js src/adapters/graphiti.js
git commit -m "feat: add MCP and Graphiti adapter seams"
```

## Task 9: Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run all tests**

Run: `node --test`

Expected: all tests pass.

- [ ] **Step 2: Run manual CLI demo**

Run:

```bash
node src/cli.js --db .fuli/demo.json space create Jevons --kind personal
node src/cli.js --db .fuli/demo.json space create "Project A" --kind public
node src/cli.js --db .fuli/demo.json subscribe Jevons "Project A"
node src/cli.js --db .fuli/demo.json remember Jevons --target "Project A" --source-kind prd --text "test_url: https://test.example.com"
node src/cli.js --db .fuli/demo.json search Jevons test_url
```

Expected output includes `https://test.example.com`.

- [ ] **Step 3: Document MVP commands**

Add exact commands and explain:

- Personal facts stay local.
- Public facts require source-like input and no personal markers.
- Candidates are quiet by default.
- Graphiti is the intended production graph backend; the JSON file store is the MVP executable backend and test harness.

- [ ] **Step 4: Commit**

Run:

```bash
git add README.md
git commit -m "docs: document MVP workflow"
```
