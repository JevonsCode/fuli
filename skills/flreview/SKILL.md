---
name: flreview
description: Use when the user explicitly enters /flreview or explicitly asks to run the Fuli personal knowledge review command.
---

# Fuli Knowledge Review

Review personal preferences and local personal-project knowledge with the user as the authority. Never silently rewrite, invalidate, promote, or globalize knowledge.

## Select Scope

For every `/flreview`, first offer exactly these top-level choices:

1. **全部** — review personal-global preferences plus every local personal project. Each project includes its project knowledge and project-scoped personal preferences.
2. **个人偏好** — then choose **全局偏好** or the preferences for **某一个本地个人项目**.
3. **个人项目** — then choose **一个本地个人项目** or **全部本地个人项目**. Each selected project includes both project knowledge and project-scoped personal preferences.

Use `list_personal_projects` only when a branch needs a project choice. Never include subscribed or public projects. Do not infer the current directory as the selected project and do not invent another command variant.

## Calibrate Depth

After scope selection, first ask how much patience the user has for this review.

交互硬规则：先询问用户有没有耐心；如果用户表示完全没耐心，不要再询问心情、时间或 token，只问少量最高优先级的关键问题。

- If the user says they are **完全没耐心**, immediately take the short path. Do not ask about mood, available time, or token budget. Ask only a small number of the highest-priority critical questions, one at a time, and make stopping easy.
- Otherwise ask, concisely, about current mood, available time, and whether token budget is comfortable. Use the answers plus explicit requests such as “少问一点”, “多问一点”, or “直接开始” to choose page size and explanation depth.
- Do not impose a fixed total-question cap. A tool page limit controls only one retrieval batch, not the length of the review.

## Start Or Resume

Call `start_knowledge_review` with the exact selected scope and project ID when required. Reuse a returned active or paused run. Then call `list_knowledge_review_candidates` in bounded pages.

If there is no previous completed review for that exact scope, review all historical in-scope knowledge. Otherwise present candidates in this order:

没有上次完成记录时扫描全部历史。

1. Knowledge created or changed since the last completed review.
2. Current or older conflicts, negative evidence, or items marked `requires_attention`.
3. Low-weight knowledge, using the Provider's returned utility/confidence reasons.
4. The same durable pattern repeated across multiple sessions that may deserve a personal-global attribute.

Treat ranking thresholds as Provider policy, not user requirements. Do not calculate a second conflicting score in the Agent.

## Review One Candidate

Show the content, scope, confirmation state, relevant evidence summary, weights, and why the item was selected. Ask for one outcome:

- **确认保留** — keep it; if it is pending and the user explicitly confirms the content and classification, use the normal Fuli confirmation operation first.
- **修改** — obtain the exact replacement text, apply `revise_personal_knowledge`, then record progress.
- **失效** — reconfirm the exact target, apply `revise_personal_knowledge` with `invalidate`, then record progress.
- **跳过** — do not ask again in this run; it may return in a later review.
- **稍后处理** — do not ask again in this run; intentionally return it in the next review.

After a successful mutation—or immediately for keep, skip, or later—call `record_knowledge_review_progress`. Never record a mutation outcome before its write succeeds.

For repeated cross-session patterns, ask whether the user wants a personal-global attribute, a project-scoped preference, or no promotion. Never auto-promote. Use `set_personal_preference_scope` only after explicit confirmation and only for an actual preference item.

## Pause Or Complete

If the user stops before the selected queue is exhausted, call `finish_knowledge_review` with `paused`. Resume that run next time. Only call it with `completed` after the user explicitly finishes the selected scope or no candidates remain.

Only a completed run advances the last-completed review time. Paused runs do not. A “稍后处理” item returns in the next run; a “跳过” item stays out only for the current run.

只有完成回顾才推进上次回顾时间；暂停不能推进。

## Guardrails

- Keep the user authoritative. Explain conflicts; do not resolve them silently.
- Preserve original evidence and revision history.
- Never include raw transcripts, credentials, secrets, temporary logs, or unsupported inference.
- Do not turn repeated project facts into global personal attributes without explicit approval.
- If a required Fuli review tool is unavailable, state that the installed integration needs updating; do not simulate persistence in prose.
