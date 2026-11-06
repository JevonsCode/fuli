# What FULI has proven, and its limits

English · [简体中文](capabilities-and-limits.zh-CN.md) · [README](../README.md)

What tests cover today, what is still unproven, and the privacy and safety boundaries.

## Current capabilities and evidence boundaries

Core mechanisms covered by implementation and automated tests include:

- a local personal space, exact project scope, and selective parent inheritance;
- preference confirmation, deferred conflict resolution, revision history, and source markers;
- bounded task-prompt recall, focused on-demand retrieval, and material-usage auditing;
- task entry and completion checkpoints, plus local Claude Code, Codex, and Cursor lifecycle adapters (hook coverage in [Agent integrations and MCP tools](agent-tools.md));
- decision options, rationale, and validation results supplied during initial capture;
- knowledge-usage events, negative feedback, and content-generation isolation;
- persistent scoped knowledge reviews with pause/resume watermarks;
- common-knowledge discovery and preview-token-protected atomic promotion;
- read-only multi-project MCP, Notion, Feishu/Lark, Dify-compatible RAG Retrieval API, and trusted-code bindings with connected retrieval.

New in 0.20 (public preview `0.20.0-beta`, see the [release notes](releases/0.20.0.md)):

- **Projects and people**: unassigned conversations go to Astro, Jefa triages them, and when a topic keeps coming back (three conversations over at least two days) Astro asks whether to make it a project with its own people. Every project has a brief and every Agent an occupation, which Bole recruits by.
- **Tasks**: assign without starting (backlog), and stop, retry, or review any run from the task details. A temporary failure is retried automatically only when no prompt was sent.
- **Decisions**: an Agent that needs you asks in the conversation first. A request that must wait for you goes to the Decisions page, and your reply reaches the Agent that asked.
- **Roundtable**: besides asks (`message_agent`), Agents have direct and group chats (`agent_chat`) with push delivery and `wait`; the console shows them live.
- **Memory between projects**: weighted links (related, frequent, close) say how much one project may draw on another. Weights never grant access.
- **Lower token cost**: a smaller task entry, shared rules read on demand, long preference lists read in pages, and a Stop hook that closes routine tasks without another model turn.
- **Console**: six entries (Workbench, Agents, Conversations, Projects, Memory, Settings), a phone layout, and Alt/Option-click explanations for any status or term.
- **Windows**: download `FULI-Setup-<version>.exe` from the release and double-click it to install for your user (no terminal, no administrator; unsigned for now, so SmartScreen asks once). The installed build has Update-Fuli, Rollback-Fuli, and Uninstall-Fuli that keeps your data; the console's 「Update to vX」 downloads the release's verified Windows package and runs the same update in one click.

The following must not be presented as already proven:

- the A/B thresholds in `FULI_ALIGNMENT_BENCHMARK.md` are acceptance conventions; claims that Fuli
  reduces explanation or rework require a sufficiently large set of controlled, real paired tasks;
- benchmark projects and conversations are explicitly labeled **MOCK / synthetic data**, not user or
  production data; the measured token use and recall accuracy so far, small-sample trends on
  synthetic projects, are on the [token and accuracy report](https://xn--8ovp9s.xn--m8txu.com/fuli/report/en/);
- the decision tool can include validation during initial capture, but it does not yet expose a
  dedicated operation for appending immutable validation results to an existing `Decision`;
- Installed files do not prove host loading, trust, or execution. Claude Code and Codex adapters
  generate entry/Stop hook configuration; Codex trust review remains a user action. Cursor uses
  task-entry hooks and bounded Stop reminders, not an equivalent unconditional Stop gate. Ordinary
  input in each real client still requires live acceptance;
- selected public projects in connected retrieval are Beta; external-to-public promotion and
  background delta synchronization are not implemented.

## Privacy and safety boundaries

- Personal knowledge is written to the local Provider.
- Agents distill structured knowledge separately from private, adapter-visible conversation journals.
- Tokens, cookies, private keys, credentials, private contact details, temporary logs, and raw command
  output must not enter the graph.
- Graphiti's remote-LLM path is disabled; embeddings are currently computed locally.
- Searches are bounded by personal space and project scope instead of mixing every project.
- External connectors never write to third-party sources; raw credentials are rejected from stored
  binding configuration.
- Shared promotion requires auditable human confirmation. Agent usage evidence can promote an item
  only as far as `agent_confirmed`.
- Fuli is not a real-time monitoring or Git service; current state must be read from the relevant
  source system.
