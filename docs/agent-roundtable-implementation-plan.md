# Agent Roundtable Product Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish an installable Fuli beta supporting persistent, controlled collaboration between independently connected agents on multiple computers, with Grok API and truthful platform capabilities.

**Architecture:** Fuli retains identity and knowledge authority. A JavaScript roundtable domain uses an explicit transactional SQLite collaboration store and participant ports. HTTP/MCP, CLI workers, native client adapters and Vue views consume the same service; no transport implements separate domain behavior.

**Tech Stack:** Node 24 node:sqlite, MCP SDK, plain JavaScript, Vue 3, existing Fuli application ports.

## Contracts

Service: `createRoundtableService({databasePath, clock})` exposes `create(input, actor)`, `list(input, actor)`, `read(input, actor)`, `invite(input, actor)`, `revoke(input, actor)`, `authenticate(input)`, `join(input, actor)`, `claim(input, actor)`, `submit(input, actor)`, `control(input, actor)`, `addHumanMessage(input, actor)`, `close()`.
Actor is created at the trusted transport boundary: local owner or authenticated exact room/seat participant; actor fields from request bodies are ignored. Participants cannot create rooms, invitations, change limits, impersonate peers, or access other rooms. Invites are random bearer capabilities, hash-only persistence, bounded expiry, revocable; owner-only API issues them once.
Room input: goal, mode discussion/collaboration, optional validated project binding, seats [{id,name,role:moderator|specialist|implementer|reviewer,runtime:mcp|codex|claude-code|grok|a2a}], bounded limits. Absence of project creates a labeled temporary collaboration scope. read returns room, ordered messages, current turn, tasks/outcome, next cursor. Claim returns turnId, attemptId, fence, deadline, scoped context. Submit has roomId, turnId, attemptId, fence, idempotencyKey, body, kind, artifacts and reported verification. Atomic submit appends one final message and advances legal state; expired results never become current. Reported evidence is not human acceptance.

## Tasks

### 1. Research and protocol choices
- [ ] Verify official GitHub projects, licenses and Grok Bot vs API contracts; save source links in docs/roundtable-research.md.
- [ ] Borrow lifecycle, interruption and scoped federation patterns; integrate SDKs only at adapters. Document actual compatibility.

### 2. Collaboration domain and persistence
Files: src/roundtables/{store,domain,service}.js; test/roundtable-service.test.js.
- [ ] Write focused tests for invite isolation/revocation, ordered claims, duplicate submission, stale fence, hard stops and restart recovery.
- [ ] Implement CAS transactions and bounded logs, phase flow, role checks, task dependencies, dissent/artifact evidence and temporary scope.
- [ ] Run `node --test test/roundtable-service.test.js`; require meaningful behavior checks, no fabricated model evidence.

### 3. Application and transports
Files: src/roundtables/{http-router,server,mcp-tools,application}.js; src/cli/roundtable-command.js; src/cli.js; src/graphiti/federated-application.js; src/http/api-router.js; src/agent-tools.js; test/roundtable-http.test.js; test/roundtable-mcp.test.js.
- [ ] Bind validated Fuli scopes/agent identities via application ports; keep standalone identities explicitly independent.
- [ ] Integrate owner UI route and restricted peer HTTP/MCP with exact-room bearer auth, body bounds and no owner-tool exposure.
- [ ] Add `fl roundtable serve` and `fl roundtable worker`; workers pull only their authorized turns and submit actual results.
- [ ] Test two independent network clients A -> B -> A, restart persistence and all unauthorized routes.

### 4. Runtime ports and adapters
Files: src/roundtables/{driver,participant-registry,worker}.js; src/agents/codex/roundtable-participant.js; src/agents/claude-code/roundtable-participant.js; src/agents/grok/roundtable-participant.js; src/agents/a2a/roundtable-participant.js; test/roundtable-runtime.test.js.
- [ ] Add explicit adapter preflight/dispatch/cancel, argument arrays without shell, owned process cancellation and per-turn deadlines.
- [ ] Disable inherited full MCP tools and unsafe hooks in controlled local runs; readonly default, workspace permissions explicit.
- [ ] Implement API auth through env references, bounded contexts, actual usage, cancellation; HTTP errors remain failures.
- [ ] Test transport errors/timeouts/cancellation and protocol fixtures separately from real credentialed runs.

### 5. Product UI and map
Files: web/src/features/roundtables/*; web/src/router/index.ts; web/src/layouts/ConsoleLayout.vue; site/index.html; site/style.css; README.md; README.zh-CN.md.
- [ ] Add room creation, list/detail, seats/invite copy, live messages, controls, task results/dissent and truthful runtime receipt table.
- [ ] Use GrowthLoading with actual bilingual pending labels and preserve loaded content; check small-screen behavior.
- [ ] Add product capability map separating available, beta and planned capabilities; no unsupported Bot integration claims.
- [ ] Run Vue typecheck, focused component tests and build; visually inspect actual UI/site.

### 6. Verify, review and publish
Files: acceptance/roundtable-network.js; docs/roundtable-beta-testing.md; package.json; npm-shrinkwrap.json; release notes.
- [ ] Run focused suites, relevant full Node/Vue suites, Provider tests if affected, package smoke and dependency audit.
- [ ] Independent spec and code quality review; fix material findings before release.
- [ ] Set semver prerelease and publish GitHub prerelease triggering existing npm beta dist-tag workflow; verify registry package/tarball and website deployment.
- [ ] Provide exact multi-computer instructions, tests already performed and tests requiring user computers/credentials. Preserve primary checkout user changes.
