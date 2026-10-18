# Writing Captures

Part of the capturing-session-knowledge Skill; read SKILL.md first.

## Classify Knowledge State

Every entity and relationship needs an `originQuadrant`, `confirmationBasis`, and
`confirmationStatus`. These fields answer three separate questions:

1. `originQuadrant` records how the item was discovered. It is not a truth score and does
   not change merely because the item is later confirmed.
2. `confirmationBasis` explains why the item exists, why it belongs to that quadrant,
   who proposed it, and—when confirmed—who confirmed it and when.
3. `confirmationStatus` is `pending`, `agent_confirmed`, or `confirmed`.

Keep the canonical quadrant names:

- `known_known`: knowledge or a conclusion that was explicitly expressed when captured.
- `known_unknown`: an unresolved question or tradeoff that was explicitly recognized.
- `unknown_known`: tacit knowledge inferred from behaviour, examples, prototypes, or
  reactions.
- `unknown_unknown`: a potential blind spot surfaced during open exploration. A truly
  unknown item cannot be stored; this label describes how the recorded candidate arose.

Every `confirmationBasis` must contain:

- `existenceReason`: why this item was created;
- `quadrantReason`: why it was assigned to this quadrant;
- `proposedBy`: `{ kind, label }`, where kind is `user`, `agent`,
  `authoritative_source`, or `import`;
- `confirmedBy` and `confirmedAt` together when confirmed.

An Agent may propose and explain knowledge. A user or authoritative source creates
`confirmed`; a deterministic Fuli usage policy may create only `agent_confirmed`, with an Agent
confirmer, timestamp, and policy version. Agent confirmation is lower-authority, never
public-eligible, and must not be produced by retrieval alone. Confirmation covers the content
and its classification. If either changes, return the item to `pending` and start a new usage
generation unless the same revision explicitly records a new valid human/source confirmer and
confirmation time. Legacy items without that audit record are `pending`, even if an old
`epistemicStatus` said `confirmed`.

`currentQuadrant` and `epistemicStatus` are legacy compatibility fields. Do not use them
for new product logic and do not treat them as confirmation evidence.

Agent retrieval includes pending items on demand and returns their status so the caller can
calibrate claims. Only project knowledge whose immutable discovery-time `originQuadrant` is
`known_known` and whose status is user or authoritative-source `confirmed` may enter public
review. Knowledge first discovered as `known_unknown`, `unknown_known`, or `unknown_unknown`
remains in the personal graph even if it is later confirmed; normal personal preview and
Maintainer review gates still apply.

## Grow The Personal Profile Separately

Durable facts about the person's collaboration style use `profileAspect`. They default to
the personal-global graph without `personalProjectId`:

- `taste`: aesthetic, writing, product, architecture, or engineering outcomes the user
  likes or rejects.
- `personality`: stable self-described collaboration or working traits. Agent-inferred
  personality stays `pending` and must never be silently promoted to confirmed.
- `judgment_preference`: repeated decision criteria, tradeoff priorities, risk posture,
  and conditions that change how the user chooses.

When the user explicitly limits one preference to a project, keep `profileAspect` and capture
it with that exact `personalProjectId`; this makes the preference project-scoped without
turning it into public project knowledge. The Agent has no direct scope-write tool. Safe
narrowing from global to one exact project belongs to a trusted local UI; any broader parent or
personal global scope must use preference convergence, with an explicit target and a Provider
`HumanReviewer` channel behind trusted local user-presence. Never put any personal-profile item
into a public proposal.
For a preference that may have both global and project-specific forms, store a stable
`attributes.preferenceKey` on each form so the project value can explicitly override the same
global decision without hiding unrelated preferences.

## Route by Ownership

- Route global personal knowledge to `targetKind: personal` without `personalProjectId`; it is written directly to the local personal graph.
- Route knowledge for a local personal project, including an explicitly project-scoped personal preference, to `targetKind: personal` with that project's exact `personalProjectId`. This is private local knowledge, not a public submission.
- Route knowledge to `targetKind: project` only when the target is an explicitly selected subscribed public project. It becomes a team-shared Provider Proposal and must remain pending until a Maintainer reviews it.
- Never treat a project as public merely because the current repository or conversation has a project name. Only an active subscription makes it eligible for public project routing.
- Never omit `personalProjectId` when the current repository or conversation has already resolved one local personal project; doing so would leak project-specific facts into the personal-global scope.
- Never add another personal project to `contextPersonalProjectIds` merely because it is related, similarly named, or referenced by the active project. Automatic borrowing is limited to item-level inheritable knowledge reached through `PART_OF` or `USES_KNOWLEDGE_FROM`; all other cross-project borrowing requires an explicit user request or selection and applies only to the current search context.
- Never route project facts through the personal graph to bypass review.
- Never auto-approve a project Proposal.
- If ownership is genuinely ambiguous and changes who can see the knowledge, ask one concise question instead of guessing.

## Converge Shared Child Knowledge

When multiple direct children of one parent independently contain substantially equivalent
runbooks, conventions, or architecture facts, call `discover_common_knowledge_candidates`.
Discovery is read-only and must compare child-local knowledge with inheritance disabled so a
parent item cannot manufacture its own promotion candidate.

Never promote automatically. Preview a candidate with
`preview_common_knowledge_promotion`, show the proposed parent ownership, descendants inheritance
mode, selected duplicates, and scope rationale, then require a human confirmation reason. Apply
with `apply_common_knowledge_promotion` only using the one-time intent-bound preview token. The
Provider must atomically create or move the canonical parent item, mark descendants inheritance,
supersede child duplicates, and record the promotion audit. Child-specific exceptions stay in
their child projects.

## Resolve Or Create The Local Project

Do not run this registration flow for an already resolved temporary project. Keep its isolated
scope and retained audit history; creating or migrating to a registered project requires a
separate explicit request. Disposable output uses `retain_nothing` with a truthful work log;
any reusable project candidates remain in the returned temporary scope, subject to capture policy.

Before the first project-scoped capture in a repository:

1. Call `list_knowledge_spaces`, then `list_personal_projects` for the active personal space.
2. Resolve the repository root from the current working directory and repo-local manifests. Use a stable, human-readable project ID derived from the repository or manifest name. Never store an absolute path, local username, hostname, credential, or private remote URL as the project ID or public profile evidence.
3. Match an existing personal project by exact project ID, publication mapping, or confirmed repository identity. Do not merge projects from similar names.
4. When one previously unseen repository has an unambiguous identity, immediately create a minimal private personal project with `upsert_personal_project`. Use lifecycle `active`, a private repository source with no URI, and an evidence-coverage summary containing only facts visible in the current repository. Do not generate a generic list of information the project supposedly lacks.
5. Ask one project-identity question only when the working directory contains multiple plausible projects or the repository identity conflicts with an existing project.

Creating a personal project is local classification, not public publication. Never create or subscribe to a public project automatically.

## Structure and Flush

Use `capture_session_knowledge` with a small, coherent batch:

1. List spaces when the target IDs are not already known.
2. Summarize the durable facts; do not submit the entire source document or conversation.
3. Create stable entity keys, typed entities, and explicit uppercase relationships. When relevant, model `GitCommit`, `CodeSymbol`, `PRDSection`, `Runbook`, and `Incident` entities and connect them with relationships such as `IMPLEMENTED_IN`, `DEFINED_BY`, `MOTIVATED_BY`, `APPLIES_TO`, and `INVESTIGATED_WITH`.
4. Include source kind, source application, a non-sensitive source description, reference time, session ID, and a retry-safe idempotency key. When an online source was actually read, also include its exact stable `sourceUri`. When available, include a stable source turn ID and only the smallest relevant excerpt needed to understand the evidence; never include a full transcript.
5. Use `supersedes` when replacing a known relationship and set confidence below `1` only when the source itself expresses uncertainty.
6. Flush silently at the boundary. Continue the user's task without narrating routine capture.

If `capture_session_knowledge` or automatic project creation returns `capture_disabled`, the
user has disabled automatic capture. Do not retry, do not create a fallback record elsewhere,
and do not describe the skipped batch as stored. Existing knowledge may still be queried.

For an owned task, follow its `checkpoint_required` and `checkpoint_guidance`. Routine tasks
with nothing new to record may use the entry receipt without a model checkpoint; eligible
fallback tasks are closed as `retain_nothing` / `reported` at the next entry in the same native
session, and hook-delivered tasks by Stop. Capture candidates, experiences, memory changes,
explicit knowledge usage, collaborators and meaningful work logs (including failures/blockers)
still require `checkpoint_task_knowledge` with `capture_candidates` or `retain_nothing`.
Assigned employees include a truthful workLog, even
with `retain_nothing`; never claim automatic closure completed work or saved memory. A coordinated
worker returns its result instead of checkpointing an inherited token. Do not finish a reusable
project decision with an unflushed batch.

Only notify the user when capture fails, conflicts with existing knowledge, or requires an ownership decision. If project knowledge was proposed successfully, do not interrupt merely to announce the pending review item.
