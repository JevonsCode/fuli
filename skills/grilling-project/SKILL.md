---
name: grilling-project
description: Use when creating, clarifying, updating, or assessing a Fuli project profile, especially when the user has only a partial project description or asks to add PRDs, technical documents, frontend/backend repositories, runbooks, monitoring, or scope. Interview one question at a time, discover repository facts first, and record confirmed personal project information progressively.
---

# Grilling Project

Turn incomplete project knowledge into an evidence-backed Fuli personal project profile. Keep the interview light: discover what can be discovered, ask one useful question, recommend an answer, and wait.

Read [project-profile.md](references/project-profile.md) before assessing evidence coverage or constructing a project profile.

## Non-negotiable behavior

- During the interview, ask exactly one question in each question-bearing message. Pure status or failure notifications do not need a synthetic question.
- Before asking, use read-only repository inspection to discover relevant facts that are already available.
- State the current inference separately from confirmed facts.
- Include a recommended answer and explain its consequence briefly.
- Evidence coverage is display-only. Never block a profile update because the score is low.
- Record confirmed information in the personal graph as the interview progresses.

## Start with Fuli state

1. Call `list_knowledge_spaces` to learn the active personal space.
2. Call `list_personal_projects` for the active personal space.
3. Match by stable project ID first. Use repository evidence second. Never merge projects from name similarity alone; ask one identity question when the match is ambiguous.

Use a stable, human-readable `projectId` derived from the repository/project name. Do not derive it from a local absolute path, username, hostname, or confidential identifier.

## Discover before asking

Inspect only the current project and directly relevant files. Typical evidence includes:

- README and project documentation indexes
- package or build manifests
- architecture and deployment documents
- repository-local Git remotes
- frontend/backend directory layout
- run, test, deployment, rollback, monitoring, and incident instructions

Do not read global Git configuration, credential helpers, SSH configuration, tokens, unrelated repositories, browser data, or secret stores. Treat internal URLs and repository remotes as private evidence.

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

Before updating an existing project, call `list_personal_projects` with its exact `projectId` to read its full profile; check that the result is not truncated. After a meaningful confirmed update, call `upsert_personal_project` with the complete current profile, not a partial patch, and your current `taskContextToken` so you are recorded as the author of what you write. Preserve earlier confirmed fields and sources. Routine successful updates stay quiet.

Each of `purpose`, `scope`, `technicalSummary` and `boundaries` carries its author in `profile.authors`: `person` (the user wrote it, weight 100%, authoritative), `both` (the user edited an Agent's draft, 90%) or `agent` (an AI draft, 50%, editable). Fill empty or `agent` fields freely. Never overwrite a `person` or `both` field: FULI keeps it and lists it in `refused_fields`; tell the user what you would change and let them edit it in the console. When you report the profile, say which fields the user wrote and which are your drafts.

FULI records each real change to the profile's name, lifecycle, sources and the authored fields in the project's 修改记录, under the writer's Agent name and with the before and after text. A save that changes nothing and a field you were refused add nothing, and the record cannot be edited. The console shows it with the project's creation date on the overview; there is no Agent tool for it, so read the current profile as usual.

## Evidence coverage assessment

Recompute the assessment when evidence changes. Follow the dimensions and scoring guidance in the reference.

The assessment must contain:

- an overall score and label
- confirmed facts
- clearly marked inferences
- dimension-level evidence already present
- `analyzedAt` set to the current time

Never inflate the score from a filename alone. A discovered link confirms that a source exists, not that its content is current or complete. Never present inference as confirmed.

## Safety

Never record credentials, tokens, cookies, private keys, personal/personnel information, or unrelated machine details. Keep confidential material out of names, summaries, source titles, URIs, and assessment evidence.
