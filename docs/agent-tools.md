# Agent integrations and MCP tools

English · [简体中文](agent-tools.zh-CN.md) · [README](../README.md)

Skills and hooks FULI installs per client, the remote Claude upstream, and the MCP tool list.

## Agent integrations and primary tools

Fuli installs the `capturing-session-knowledge`, `grilling-project`, and `operating-fuli` Skills for
supported agents. The `/flreview` knowledge review was retired (11-11): its four tools are no longer listed, and
for one release a client that still calls one gets `tool_retired`. `operating-fuli` makes Agents inspect the structured interface-parity catalog before changing data,
verify writes through matching read tools, and treat browser automation as visual verification only.
See the [Agent interface architecture](agent-interface-architecture.md).
Fuli setup generates Claude Code `UserPromptSubmit`/`Stop` MCP hooks, a Codex
`UserPromptSubmit` MCP hook plus a local `Stop` command, and Cursor
`sessionStart`/`beforeSubmitPrompt`/`stop` hooks. The Codex Stop command first blocks an unfinished
checkpoint; if the same token is still unfinished after one continuation, it records only
`retain_nothing` to prevent an infinite loop and never invents knowledge or Agent memory. Codex
bootstrap and Cursor instructions retain the fallback for tasks without supplied lifecycle context;
they must not duplicate supplied preferences. Installing configuration never approves host trust.
Preference content remains in local Fuli as the single source of truth and is not copied into agent
configuration.

FULI also exposes read-only `fuli://` resources for each local personal project and for global taste.
Agents with MCP mention support can select them from the `@` picker; a project resource selects one
exact project and never expands the search to other projects or `RELATED_TO` projects.

### Remote Claude / Cowork connector upstream

`fuli remote-mcp` serves a least-privilege Streamable HTTP MCP endpoint bound to one exact personal
project. It uses the distinct `claude` client attribution, requires an owner-only bearer-token file,
rejects cross-origin requests, and listens on loopback only:

```bash
umask 077
openssl rand -hex 32 > ./fuli-remote.token
fuli remote-mcp --personal-project-id YOUR_PROJECT_ID \
  --bearer-token-file ./fuli-remote.token --port 2728
```

On POSIX systems the CLI opens the token nonblocking with no-follow semantics and requires mode
`0600`. Windows does not provide the same `O_NOFOLLOW` or POSIX mode guarantees through Node.js, so
the token must be a regular file in a directory protected by Windows ACLs and must not be a link.

Startup fails closed unless the project exists in the configured personal space. The upstream
allows at most eight concurrent sessions and evicts sessions idle for 15 minutes; tune those bounds
with `--max-sessions` and `--session-idle-ttl-seconds` when needed. Idle means no completed MCP
application request: a silent standalone SSE notification stream does not pin a slot forever and
may be closed at the TTL, after which the client must reconnect and initialize a new session.
Shutdown gives bounded requests and session cleanup one shared grace deadline before forcing the
remaining HTTP connections closed. When a reverse proxy supplies a
browser Origin or preserves its public Host, add the exact values with
`--allowed-origin https://connector.example --allowed-host connector.example`. Otherwise configure
the proxy to rewrite Host to the loopback upstream authority. Arbitrary Origin and Host values are
rejected. Each MCP session may read private context and memory only for the Agent selected by its
task entry. A checkpoint token is also bound to both the upstream's configured project and the MCP
session that created it, so neither another project process nor a peer session can reuse it.

This is an internal upstream, not a public deployment. Claude custom connectors originate from
Anthropic's cloud and therefore require a public HTTPS endpoint with OAuth 2.1 in front of this
listener. The proxy must validate user identity, token audience and scopes, then replace the external
token with the internal bearer; never expose the Fuli Provider or Neo4j ports. Local lifecycle hooks
do not run in claude.ai, so the MCP initialization instructions request task entry and checkpointing,
but only a real connected Claude conversation can prove that behavior.

When a task needs a taste or judgment recommendation, `get_user_taste_skill` generates a bounded,
read-only `user-taste` Skill projection from the effective personal profile and prior task data.
The projection labels evidence status and scope, returns task-matched recommendations, and is
regenerated as preferences are added or revised. It never overwrites a user-authored taste Skill;
the durable graph remains the source of truth.

| Tool | Purpose |
| --- | --- |
| `begin_task_context` | Hook entry: resolve the task, run bounded recall when signaled, and create a task token |
| `get_collaboration_preferences` | Fallback entry: read effective preferences and bounded task recall |
| `get_user_taste_skill` | Generate the current evidence-labeled taste Skill projection and task recommendations |
| `search_current_project_knowledge` | Search the child first, then authorized knowledge sources |
| `search_knowledge_graph` | Run a general query within an explicit bounded scope |
| `search_connected_knowledge` | Search the graph, project-bound read-only sources, and selected public projects without merging provenance |
| `record_knowledge_usage` | Record a citation or application that materially affected the result |
| `record_knowledge_feedback` | Preserve rejection, failed validation, contradiction, or stale evidence |
| `record_decision_trace` | Store options, rejected alternatives, rationale, and optional initial validation |
| `capture_session_knowledge` | Store a small structured batch of durable candidates |
| `checkpoint_task_knowledge` | Complete review with `capture_candidates` or `retain_nothing` |
| `discover_common_knowledge_candidates` | Read-only discovery of possible parent-project knowledge |
| `preview_common_knowledge_promotion` | Preview a human-confirmed promotion |
| `apply_common_knowledge_promotion` | Apply the preview atomically with a one-time token |
| `resolve_deferred_preference_conflict` | Resolve an AI-deferred conflict only when a task needs it |
