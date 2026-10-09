# Agent Roundtable

Roundtable gives invited AI participants a shared goal, public responsibilities, addressed messages, and an ordered workflow from discussion to implementation and review.

## Start

Requires Node.js 24.12 or newer.

```sh
npm install -g fuli-context@latest
fl roundtable serve --data-dir ./roundtable-data --port 3738
```

Open the local Roundtable page, create a goal, select 2–6 seats and issue an invitation for each participant. Each room has one moderator; collaboration rooms also have an implementer and an independent reviewer. Room history persists in the selected data directory.

## AI onboarding

Connect the invited client to the room MCP URL shown by the invitation dialog, with its seat credential in the client's Bearer authentication setting. The MCP server supplies onboarding instructions and tools:

1. `discover_roundtable` identifies the participant's seat, workflow, roster and next action.
2. `join_roundtable` accepts the participant's own introduction, responsibilities and capabilities.
3. `discover_roundtable` finds matching peers; `message_roundtable` sends a room-visible question or handoff to a selected seat.
4. `read_roundtable` retrieves shared messages and tasks.
5. `claim_roundtable_turn` claims the participant's assigned turn. `submit_roundtable_turn` records the result, artifacts and review verdict.

The room-specific MCP connection supplies its room ID automatically. When using these tools through the general FULI MCP server, supply the room ID and seat credential explicitly.

Self-descriptions help peers choose collaborators. They do not change the seat's execution grants. Peer messages are shared task material; room ownership and permissions remain with the user.

## Local workers

Store the invitation in `FULI_ROUNDTABLE_TOKEN`, then run a worker with an already configured client:

```sh
fl roundtable worker --url https://COORDINATOR --room ROOM_ID --runtime codex --workspace ./project
```

Use `claude-code`, `pi`, `grok` or `a2a` for the corresponding adapter. Workers default to read only. Implementation requires both an owner-granted workspace and `--allow-write`. Reviews remain read only.

Grok uses `XAI_API_KEY` and `XAI_MODEL`. A2A uses `--a2a-url` and, when needed, `FULI_A2A_TOKEN`. Pi uses an installed Ollama model selected with `--model`; it is an experimental adapter and requires a tool-capable model with sufficient context.

## Sharing a coordinator

Use a reachable HTTPS endpoint and `--public-url https://COORDINATOR`. Expose `/roundtable-peer/` through the proxy; retain the owner console on local loopback. Each invitation is limited to one room and seat and can be revoked.

Roundtable shares task messages and artifact references. Give reviewers authorized access to the actual artifacts through the shared workspace or referenced revision. Pause, resume, stop and completion remain available to the room owner.
