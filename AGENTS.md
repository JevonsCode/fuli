# FULI v2 Engineering Rules

> Product north star: **"让每一次协作，都产生复利。"** (Pure local personal edition, built in Rust.)
> Planning, architecture notes, and progress checklists live in Notion (`FULI / NEXT`), not in this repository.

## Process & Memory Boundaries (Non-Negotiable)

1. **`fuli-context`** (resident daemon + lightweight native system tray + local IPC + SQLite owner):
   - MUST NEVER depend on `gpui`, `gpui-kit`, WebView, Metal, DirectX 12, Node.js, Python, or JVM/Neo4j.
   - Idle resident memory target: **< 25 MiB**.
2. **`fuli-cli`** (`fuli` binary: `hook`, `mcp`, `open`, `status`, `stop`, `import/export`):
   - MUST NEVER depend on `gpui`, `gpui-kit`, `tray-icon`, or `rusqlite`.
   - Talks exclusively over `fuli-ipc` for sub-20ms cold hooks and ~3 MiB per MCP session.
3. **`fuli-ui`** (independent GPUI desktop window):
   - Always runs as a separate child process spawned on demand by `fuli-context`.
   - Closing the window terminates the `fuli-ui` process completely (`exit(0)` after optional short grace period) so 100% of GPU and font-atlas memory returns to the OS.
4. **`fuli-ui-kit`** (reusable component library):
   - All pages in `fuli-ui` compose from `fuli-ui-kit` tokens and primitives. Never scatter raw page-local colors or control heights.

## Kernel vs Pluggable Extensions

- **Immutable Kernel**: `fuli-domain`, `fuli-store` (single SQLite WAL `fuli.db`), `fuli-search`, `fuli-delivery`.
- **Pluggable Upper Modules**: `fuli-roundtable` (lightweight cross-bot Q&A & session wake by native `session_id`), `fuli-dreaming` (two-tier periodic curation), global portfolio/report aggregation, on-demand preference judgment, and `FULI Bot` Workbench/Workflow UI. Upper modules depend on kernel ports; the kernel never depends on them.

## Product & UX Iron Rules

- **Official entity name**: `FULI Bot`. Keep its memory, Workbench, and Workflow; never reintroduce HR/hiring/dismissal/loan bureaucracy or forced random English human names.
- **Minimize human interruption**: Auto-apply routine, reversible work and explicit user statements silently (always inspectable & 1-click undoable). Only ask the human for real rule conflicts, destructive/permission changes, or uncertain major promotions.
- **Speak plain human language (说人话)**: Zero internal jargon, enum names, schema field names, or robotic translations in any user-facing UI or message. Prefer concise punchy text + diagrams/visuals + 1-click choices.
- **Visual documentation (`show-me` style)**: For architecture docs, handoffs, and Notion reports under `FULI / NEXT`, follow the `humanlayer/skills` `show-me` style — lead with concise file trees, Mermaid diagrams, pseudocode, diffs, and focused HTML visuals rather than long prose walls.

## Git & Delivery

- Integration branch for the Rust rewrite: `next`, with feature/milestone branches named `next/<topic>` (never include `codex` in branch names).
- Never `git push` without explicit user authorization.
- Every behavior change ships with focused unit/integration tests and passes `cargo test --workspace` plus Windows & macOS CI.
