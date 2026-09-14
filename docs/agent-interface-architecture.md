# Agent interface architecture

FULI exposes product data operations through structured Agent tools so an AI Agent does not need browser automation to act on the user's behalf. The console and the Agent interface are peer clients of the same application services; neither client owns a second copy of the business rules.

## Contract

`list_agent_interfaces` returns the versioned `agent-interface-parity-v1` catalog. Every console data mutation is classified as one of:

- `agent`: the catalog names the structured Agent tool or tools that perform the same business operation.
- `local_user_only`: the catalog records why the operation requires local human presence.

The parity catalog is executable product metadata, not just documentation. Tests verify that every `agent` entry names a registered tool and that sensitive local-only routes remain explicit. A route with multiple actions, such as ignoring or resetting routing-learning evidence, lists every matching tool.

## Request path

```text
Console UI ───────┐
                  ├─> application service ─> scoped Provider / local store
Agent tool / MCP ─┘
```

Agent handlers delegate to existing application-service methods. They do not call the console over HTTP, render pages, write browser state, or bypass scope checks. Existing Host/Origin protection remains relevant to the console; Agent access is independently guarded by the Agent-access policy before any tool handler runs.

## Required operating sequence

### Agent names and human attention

Agent identity (`agentId`) and role (`profile.name`, `responsibility`) remain stable.
`profile.displayName` is the editable person-like nickname. Legacy role-style names
receive a deterministic nickname derived from their Agent ID; existing custom names
and explicit display names are preserved. These are product nicknames, not real people.
Reading a legacy profile does not rewrite its stored history.

Use `request_agent_attention` only for an explicit human action, with the exact space,
project and Agent, optional task ID, request kind, context and `requestedAction`.
The same idempotency key and payload returns the same request, including after closure;
reusing a key with another payload is a conflict. Running, waiting in a queue and
recoverable retries do not create attention requests automatically.

`list_agent_attention` supports project/Agent/status filters and pagination. Counts
cover the whole filtered set. Agents can withdraw obsolete requests with
`cancel_agent_attention`, using `expectedRevision` and a reason. Only the local-user
`POST /api/agent-attention/respond` workflow records a human reply. A reply closes the
attention item but does not itself grant permission, accept a task or run a command.
Agents read resolved replies and continue within the existing authority boundaries.
Original context, response, actor and timestamps remain in the private graph.

The console uses one shared attention store and dialog for the sidebar and personnel
views. Failed reads remain visible as errors, not a false empty state. Replies use
revision checks and preserve the user's draft on failure. Public reports never query
or expose this private attention queue.

An Agent should:

1. call `list_agent_interfaces`;
2. resolve exact space, project, item and version identifiers with read tools;
3. inspect the selected tool's current schema;
4. read current state before a write;
5. execute the narrowest scoped mutation with available compare-and-swap or idempotency fields;
6. verify through a structured read.

The bundled `operating-fuli` Skill teaches this sequence and is installed by `fuli setup` for supported Agents. Browser automation is permitted only as optional visual verification after a structured operation, never as a data-mutation fallback.

## Human-only boundaries

The following operations intentionally remain local-user-only:

- enabling or disabling Agent access;
- device-level runtime settings;
- completing a preference conflict as a human decision;
- confirming preference visibility scope;
- batch confirmation of knowledge.
- Jefa task completion that records explicit human acceptance (other task updates remain available through the employee tools).

These are trust boundaries, not missing interfaces. An Agent may explain where the user can perform the action, but must not substitute direct HTTP, storage, shell, or browser scripting.

## External knowledge

Connector discovery, binding creation, readiness checks, target updates, scoped synchronization, live retrieval, conflict policy and deletion have dedicated tools. Connector secrets are referenced by environment-variable name; tool results and catalog listings must not expose secret values.

Moving a connection between projects updates the binding targets. Deleting and recreating a binding is not the default because it breaks audit continuity and can discard connector state.

Target updates require the Agent's last-read `targetsVersion`. Registry mutations take a cross-process SQLite reservation, so sync/check/delete cannot overwrite a concurrent scope update. Busy or stale writes fail with a controlled conflict and must be re-read, not blindly retried. The legacy HTTP contract still accepts callers without a version for compatibility; current console and Agent clients supply one.

## Adding a feature

When a console feature adds a data mutation:

1. implement the business operation in an application service;
2. have the console route call that service;
3. add or reuse a typed Agent definition and a handler that calls the same service;
4. annotate read/write, destructive and open-world behavior for MCP clients;
5. add the route-to-tool mapping to `src/agent-tools/interface-catalog.js`, or document a narrowly justified `local_user_only` boundary;
6. add contract tests covering dispatch, scope, error behavior and the parity mapping;
7. update the `operating-fuli` workflow reference if the operation needs a non-obvious sequence.

A missing Agent interface must remain visible as a parity defect. Do not silently ship a browser-only write path.
