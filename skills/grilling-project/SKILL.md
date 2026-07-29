---
name: grilling-project
description: Use when creating, clarifying, updating, assessing, or publishing a Fuli project profile, especially when the user has only a partial project description or asks to add PRDs, technical documents, frontend/backend repositories, runbooks, monitoring, scope, or public-project metadata. Interview one question at a time, discover repository facts first, record confirmed personal project information progressively, and never publish before a final public-boundary preview is confirmed.
---

# Grilling Project

Turn incomplete project knowledge into an evidence-backed Fuli personal project profile, then optionally publish it. Keep the interview light: discover what can be discovered, ask one useful question, recommend an answer, and wait.

Read [project-profile.md](references/project-profile.md) before assessing evidence coverage or constructing a project profile.

## Non-negotiable behavior

- During the interview, ask exactly one question in each question-bearing message. Pure status or failure notifications do not need a synthetic question.
- Before asking, use read-only repository inspection to discover relevant facts that are already available.
- State the current inference separately from confirmed facts.
- Include a recommended answer and explain its consequence briefly.
- Do not publish a public project until the user confirms a final publication preview.
- Evidence coverage is display-only. Never block publication because the score is low.
- Record confirmed information in the personal graph as the interview progresses. Personal recording is not public publication.
- Do not silently turn a related project into a subscription. Subscription is always explicit.

## Start with Fuli state

1. Call `list_knowledge_spaces` to learn the active personal space, public Provider state, subscriptions, and public projects.
2. Call `list_personal_projects` for the active personal space.
3. Match by stable project ID or an existing publication mapping first. Use repository evidence second. Never merge projects from name similarity alone; ask one identity question when the match is ambiguous.
4. If a public project already corresponds to it, treat publication as a profile sync, not a second project.

Use a stable, human-readable `projectId` derived from the repository/project name. Do not derive it from a local absolute path, username, hostname, or confidential identifier.

## Discover before asking

Inspect only the current project and directly relevant files. Typical evidence includes:

- README and project documentation indexes
- package or build manifests
- architecture and deployment documents
- repository-local Git remotes
- frontend/backend directory layout
- run, test, deployment, rollback, monitoring, and incident instructions

Do not read global Git configuration, credential helpers, SSH configuration, tokens, unrelated repositories, browser data, or secret stores. Treat internal URLs and repository remotes as private evidence until the user explicitly approves public inclusion.

Label every proposed fact as one of:

- **confirmed** — directly stated by the user or supported by inspected evidence
- **inferred** — plausible but not yet confirmed

Summarize only information and evidence that currently exist. Do not present a generated
list of “missing items”; absence from a generic checklist is not evidence that the project
actually needs that item.

Do not ask the user for a fact that can be verified safely from the current repository.

## Interview loop

Choose the highest-impact clarification that follows from the user's goal or current
evidence. Do not manufacture questions solely to fill a generic checklist. In each turn:

1. Summarize newly confirmed facts in one or two sentences.
2. State any relevant inference and its evidence.
3. Ask one question only.
4. Put the recommended answer first and explain the tradeoff.
5. Wait for the answer.

Prefer project identity, purpose, scope, and privacy boundary before lower-impact metadata. Skip resolved categories. If the user rejects a recommendation, record their choice without repeatedly arguing.

After a meaningful confirmed update, call `upsert_personal_project` with the complete current profile, not a partial patch. Preserve earlier confirmed fields and sources. Routine successful updates stay quiet.

## Evidence coverage assessment

Recompute the assessment when evidence changes. Follow the dimensions and scoring guidance in the reference.

The assessment must contain:

- an overall score and label
- confirmed facts
- clearly marked inferences
- dimension-level evidence already present
- `analyzedAt` set to the current time

Never inflate the score from a filename alone. A discovered link confirms that a source exists, not that its content is current or complete. Never present inference as confirmed.

## Publication gate

When the profile is useful enough for the user to review—or the user asks to publish—show one final preview containing:

- project name, purpose, scope, and lifecycle
- public sources and links
- excluded private or restricted sources
- confirmed and inferred existing information
- evidence coverage score with the sentence “资料覆盖仅用于展示，不影响发布”
- the selected public Provider
- the consequences: publisher becomes Owner and Maintainer, and the personal space is automatically subscribed

Ask one final question: whether to publish this exact preview. Recommend publishing when the public boundary is clear; sparse evidence does not block publication.

If more than one public Provider is ready and no existing project mapping determines the target, ask one Provider-selection question before the final preview. Do not select the first Provider implicitly.

Confirmation approves only the public sources and links individually listed in that preview. Unlisted sources remain private or restricted.

Only after explicit confirmation, call `publish_personal_project` with `personalSpaceId`, `localProjectId`, and `providerUrl` from the preview.

If no public Provider is connected:

- continue building the personal project profile normally
- do not offer a fake or queued publication
- explain once, when relevant, that public publication is unavailable until a Provider is connected
- do not automatically replay publication later

## Project relationships

Use `create_project_relation` only after both public projects are identified and the user confirms the relationship type.

- `PART_OF` means a real hierarchy and requires confirmation by a Maintainer of the parent project.
- `DEPENDS_ON` means a runtime, delivery, or development dependency.
- `PROVIDES_TO` means one project supplies a capability to another.
- `SHARES_CAPABILITY_WITH` means reusable capability overlap without hierarchy.
- `SUCCESSOR_OF` means replacement or evolution.
- `RELATED_TO` is the fallback when no stronger semantics are confirmed.

Do not use `PART_OF` merely because two projects are in the same business domain. Do not subscribe to the related project unless the user separately asks.

## Safety

Never record or publish credentials, tokens, cookies, private keys, personal/personnel information, or unrelated machine details. Keep confidential material out of names, summaries, source titles, URIs, assessment evidence, and publication previews.

Sources marked `private` or `restricted` may remain in the personal profile but cannot be sent to the public Provider. If the public profile would reveal company-confidential information, stop and ask one boundary question before proceeding.
