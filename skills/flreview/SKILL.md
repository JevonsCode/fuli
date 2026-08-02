---
name: flreview
description: Use when the user explicitly enters /flreview or explicitly asks to run the Fuli personal knowledge review command.
---

# Fuli Knowledge Review

The invoking Agent owns each review session. FULI supplies durable knowledge, deterministic candidate ranking, and write tools; the Agent generates a fresh interactive review page for this invocation. There is no permanent **知识回顾** tab to open.

## Start The Session

For every exact `/flreview` invocation or explicit request to run the Fuli knowledge review:

1. Use `list_knowledge_spaces` to identify the active personal space, then call `list_personal_projects` so every project choice uses a real local personal project.
2. Use the `visualize` Skill to render an inline setup page in the current task. Collect scope and review depth in that page, not as serial chat questions. Ask patience first. If the user selects **完全没耐心**, hide mood, available-time, and token-budget fields and use a small highest-priority batch. Otherwise collect mood, available time, and token comfort together on the same setup page. These answers control only batch size and explanation depth, never Provider ranking. If the user's request already gives an exact scope and depth, skip setup.
3. On the setup page's explicit start action, call `start_knowledge_review` with the selected scope. Then call `list_knowledge_review_candidates` with a bounded page size matching the selected depth.
4. Generate all candidates from that batch on the same interactive page. Show all candidates at once; do not reveal them one at a time.

The setup scope tree is:

- **全部** — global preferences plus every local personal project's knowledge and project-scoped preferences.
- **个人偏好** — global preferences or one selected local personal project's preferences.
- **个人项目** — one selected local personal project or all local personal projects. A project includes its knowledge and project-scoped preferences.

Never infer the current directory as the selected project. Never include subscribed or public projects.

A bounded page limit is a batch size, not a fixed total-question cap.

## Generated Review Page

Follow the `visualize` Skill's inline-artifact rules. The artifact must not use `fetch`, XHR, WebSocket, or a direct FULI API. Every submitted action must call:

```js
await window.openai.sendFollowUpMessage({ prompt, title })
```

The setup action envelope contains only `action`, `personal_space_id`, scope, optional project, and depth inputs. It must not invent a `review_id`, `candidate_key`, `item_id`, or `item_kind`. Every candidate action envelope contains `personal_space_id`, `review_id`, `candidate_key`, `item_id`, and `item_kind`, plus only the fields needed for that action. Treat a valid envelope as a continuation of the active review, not as a new `/flreview` invocation.

Each candidate card shows its content, current scope and source projects, confirmation state, `current_quadrant`, selection reasons, relevant evidence counts, utility, and confidence. Provider order is authoritative; do not invent a second score. Render these actions:

- **确认保留**
- **修改**
- **调整范围**
- **失效**
- **稍后处理**
- **交给 AI 判断**

Do not present the review as one candidate at a time in chat. Chat may contain only a concise status and the generated interactive artifact.

## Action Semantics

Do not mutate knowledge until the user submits an explicit visualization action. After any mutation, call `record_knowledge_review_progress` only after the write succeeds. If progress recording fails after a successful write, retry only progress; never repeat the mutation.

### 确认保留

If the candidate is already confirmed, record `confirmed`. If it is pending, first call `revise_personal_knowledge` with `action: confirm`, an auditable user confirmation basis, and no content or taxonomy changes; then record `confirmed`.

### 修改

Collect the exact replacement content and a reason in the card. Call `revise_personal_knowledge` with `action: update`, then record `updated`.

### 调整范围

- For a global preference with exactly one source project, offer a one-click move to that source project. With multiple source projects, require a project selection. Call `set_personal_preference_scope` with `scope: project` and the selected source project.
- For a project-scoped preference, offer promotion to global and call `set_personal_preference_scope` with `scope: global`.
- Ordinary project knowledge is not a personal preference. Never offer to turn ordinary project knowledge into a global preference.

After a successful scope write, record `updated`. Never change scope automatically.

### 失效

Offer these preset reasons and a custom reason field:

- 不应该沉淀为一条复利知识
- 不知所云
- 过期了
- 只在当时生效

Selecting a preset or entering a non-empty custom reason is sufficient authorization. There is no second confirmation and no confirmation checkbox. Call `revise_personal_knowledge` with `action: invalidate`, then record `invalidated` with the exact reason.

### 稍后处理

Do not mutate the knowledge. Record `deferred` and remove it from the current page. FULI carries it into the next review as `deferred_from_previous` even if no other ranking threshold still matches.

### 交给 AI 判断

This action means the user cannot responsibly classify the item now. Call `revise_personal_knowledge` with `action: update`, `currentQuadrant: unknown_unknown`, and a short `reasoningSummary` stating that the user delegated judgment during knowledge review. Never send `originQuadrant`: discovery classification is immutable evidence. The required order is `revise_personal_knowledge` before `record_knowledge_review_progress`. After that write succeeds, record `delegated_to_ai` and remove the item from the current page.

## Continue, Pause, Or Complete

After each successful action, refresh the current review's remaining candidates and regenerate the interactive page. Load the next bounded batch when the current batch is exhausted.

Call `finish_knowledge_review` with `paused` when the user explicitly pauses. Call it with `completed` only when no candidates remain or the user explicitly finishes the selected scope. Only completion advances the last-completed watermark.

## Guardrails

- FULI-saved knowledge is the only candidate source. Never fabricate, mock, or supplement candidates from ordinary search.
- Keep original evidence and revision history intact.
- Never silently resolve conflicts, invalidate knowledge, or change scope.
- If a required FULI or visualization capability is unavailable, report the exact missing capability and stop safely.
