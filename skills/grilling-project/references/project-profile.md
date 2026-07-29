# Fuli project profile reference

Use this reference to construct the complete payload for `upsert_personal_project`.
Optional fields may be absent. Publication is never blocked by this guidance.

## Profile fields

- `name`: confirmed user-facing project name
- `purpose`: problem solved, primary users, and intended outcome
- `scope`: included and excluded product or technical boundaries
- `technicalSummary`: architecture, important modules, runtimes, and constraints
- `lifecycle`: `planned`, `active`, `maintenance`, or `archived`
- `sources`: evidence records described below
- `boundaries`: durable development, ownership, privacy, and operational rules
- `assessment`: evidence-backed summary of information currently recorded

## Source records

Every source needs a stable `key`, `kind`, and `title`. Add `uri` and `summary` only when supported by evidence.

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

- `normal` only when the source is approved for public inclusion
- `private` for personal or non-public project evidence
- `restricted` for highly controlled evidence that must never reach a public Provider

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
6. `governance` — privacy boundary, contribution rules, maintainership, and durable development rules

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

## Publication checklist

Before asking for final confirmation, verify the preview explicitly covers:

- project purpose and scope
- PRD/product documentation
- technical documentation
- frontend and backend repository evidence
- runbook or local run/deployment instructions
- monitoring and error-diagnosis instructions
- privacy and public-sharing boundary
- durable project development rules
- confirmed and inferred existing information
- Owner/automatic-subscription consequence

Sparse evidence never prevents publication.
