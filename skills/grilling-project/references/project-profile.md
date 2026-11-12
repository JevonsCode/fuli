# Fuli project profile reference

Use this reference to construct the complete payload for `upsert_personal_project`.
Optional fields may be absent.

## Profile fields

- `name`: confirmed user-facing project name
- `purpose`: problem solved, primary users, and intended outcome
- `scope`: included and excluded product or technical boundaries
- `technicalSummary`: architecture, important modules, runtimes, and constraints
- `lifecycle`: `planned`, `active`, `maintenance`, or `archived`
- `sources`: evidence records described below
- `boundaries`: durable development, ownership, privacy, and operational rules
- `assessment`: evidence-backed summary of information currently recorded

FULI records who wrote `purpose`, `scope`, `technicalSummary` and `boundaries` in `profile.authors`; do not send `authors`, it is computed from who writes. Pass `taskContextToken` so your FLA is named. A field authored `person` or `both` is not changed by an Agent call and is returned in `refused_fields`; the other fields of that call still apply.

## Source records

Every source needs a stable `key`, `kind`, and `title`. Add `uri` and `summary` only when supported by evidence.

For a `repository`, `frontend_repository`, or `backend_repository` source, use the repository's
`origin` remote URL (without credentials) as `uri` when it is known. Set `role` to `reference` for a
repository this project only refers to (a candidate base, an upstream, another team's code); leave it
out or use `own` for the project's own repository. A source saved without `role` counts as `own`,
so when you rewrite `sources`, send `role: reference` again for every reference source you keep.

FULI resolves any clone or worktree to the project whose own repository source records the same
remote, when exactly one does; ssh and https forms of one repository are equal, and `reference`
sources never match. Only when the checkout's folder (or a worktree's original repository) names
another current project that has an own repository source without a `uri` does the task's project
stay ambiguous until the person names one project or marks the other's source `reference`; give
your own repository its `uri` to avoid that. A checkout whose folder is named after a project
that records another repository does not resolve to it. Keep the source `private` unless the user
said it may be shared.

Supported kinds:

- `prd`
- `product_document`
- `technical_document`
- `frontend_repository`
- `backend_repository`
- `repository`
- `design`
- `runbook`
- `monitoring`
- `issue_tracker`
- `other`

Set sensitivity to:

- `normal` for evidence the user may share freely
- `private` for personal or internal project evidence
- `restricted` for highly controlled evidence that must never leave this computer

Do not store credentials at any sensitivity.

## Evidence coverage dimensions

Use these dimensions only to summarize evidence already present, not to declare what a
project is missing. Each dimension has a 0–100 coverage score. The overall score should
be a reasoned weighted average of supported evidence, not an unexamined count of links.

1. `identity` — purpose, users, lifecycle, scope, and exclusions
2. `product` — PRD or equivalent product evidence and current requirements
3. `technical` — architecture, key modules, interfaces, and constraints
4. `code` — confirmed frontend/backend repositories and ownership boundaries
5. `operations` — run, deploy, rollback, monitoring, and incident evidence
6. `governance` — privacy boundary, contribution rules, ownership, and durable development rules

Suggested weighting:

- identity: 20%
- product: 20%
- technical: 20%
- code: 20%
- operations: 10%
- governance: 10%

Scoring evidence:

- 80–100: current, direct, and sufficiently detailed evidence
- 50–79: partial evidence with material gaps
- 20–49: mainly user statements or weak/inferred evidence
- 0–19: no usable evidence currently recorded or evidence is contradicted

Overall labels:

- `needs_clarification`: 0–39
- `partially_documented`: 40–74
- `well_documented`: 75–100

Each dimension contains:

- `key`
- `label`
- `score`
- `state`: `confirmed` or `inferred`
- `evidence`: short statements pointing to the evidence

The assessment contains `confirmed` and `inferred` summaries only. It does not contain a
generated `missing` list. A zero score means Fuli currently has no usable evidence for
that dimension; it does not claim the project must add a particular artifact.
