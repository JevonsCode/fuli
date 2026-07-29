# Compound Interest Engineering Rules

## Product Boundaries

- Prefer plain JavaScript for application code unless another language has a clear technical advantage.
- Keep the local-first, human-authoritative, query-on-demand product principles intact.
- Preserve temporal history; current answers and historical records are separate concerns.

## Module Boundaries

- Each file owns one clear responsibility and has one primary reason to change.
- Split a module when it starts coordinating unrelated capabilities or accumulating unrelated helpers.
- Keep entry points and composition roots thin; they wire modules together rather than implement domain behavior.
- Prefer capability-specific modules over catch-all `utils`, `helpers`, `services`, or manager files.
- Depend on explicit ports at boundaries. Keep storage, domain behavior, transport, and UI concerns separate.
- Do not expose adapter internals to callers. Add behavior to the owning port instead.
- File size is a warning signal, not a target. Readability and responsibility boundaries decide when to split.

## Common and Agent-Specific Boundaries

- Keep product behavior, knowledge routing, MCP contracts, and reusable Skills Agent-agnostic by default.
- Do not add Agent-specific hooks, prompts, branches, or file formats to the common layer when the behavior applies to every supported Agent.
- Put unavoidable Agent-specific integration under an explicit directory owned by that Agent, such as `*/agents/claude-code/*`, `*/agents/codex/*`, or `*/agents/cursor/*`.
- Access Agent-specific implementations through a shared port or registry. Keep Agent ID branching in the adapter composition boundary instead of spreading it through domain or MCP code.
- When a change introduces Agent-specific behavior, add focused tests in the same Agent-specific boundary and verify that common behavior remains unchanged.

## Delivery

- Add focused tests for each behavior change and run the relevant suite before committing.
- Keep commits scoped to one task and do not mix unrelated refactors into feature work.
- Use codebase-memory-mcp for structural discovery when available, then read the exact files before editing.
