---
name: operating-fuli
description: Use when an AI Agent needs to inspect or change FULI knowledge, personal projects, Project Agents, specialist Agents, public-project subscriptions, reviews, capture policy, or external-knowledge connections through structured tools instead of browser automation. Also use to check whether a FULI UI action has an Agent interface and to explain a deliberate local-user-only boundary.
---

# Operating FULI

Operate FULI through its structured Agent interfaces. Treat the UI and Agent tools as two clients of the same application services; never use browser clicks as a data mutation fallback.

## Required workflow

1. Establish the exact scope from the current task. Resolve real `personalSpaceId`, `personalProjectId`, item IDs, and versions through read tools. Never guess an identifier or infer one from a display name.
2. Call `list_agent_interfaces` before the first mutation. Use its catalog to determine whether the UI capability is `agent` accessible or intentionally `local_user_only`.
3. Inspect the exact input schema for the selected tool. Prefer one domain-specific tool over generic HTTP, shell, database, or browser access.
4. Read the current record immediately before changing it. Preserve fields the user did not ask to change.
5. Check the safety boundary below. Stop if the action needs missing user authority or is marked `local_user_only`.
6. Execute the smallest scoped mutation. Supply `expectedRevision`, `expectedUpdatedAt`, `idempotencyKey`, or request IDs whenever the tool supports them.
7. Re-read through the corresponding structured read tool. Report the actual resulting scope, version, status, and any partial failure.

If an expected capability is absent from `list_agent_interfaces`, report an Agent-interface parity gap. Do not hide the gap by opening Chrome, clicking the UI, writing storage directly, or searching outside the current repository.

## Safety boundary

- Never enable or weaken Agent access through an Agent tool. The Agent-access kill switch remains a local-user control.
- Never change device/runtime settings or complete human confirmation queues on the user's behalf when the catalog marks them `local_user_only`.
- Never mark a Jefa work item complete through its human-acceptance workbench route; use an Agent task-update tool only for non-acceptance workflow changes.
- Require explicit user authorization for deletes, publication, subscription changes, destructive conflict decisions, or changes that affect another project. An unambiguous request already authorizes that exact action; do not ask again unless the target or consequences remain unclear.
- Use environment-variable references for connector secrets. Never request, print, store, or copy secret values into knowledge records, logs, Skill files, or tool arguments that expect only a reference.
- Stay inside the exact FULI workspace and registered project scopes. Do not use home-directory-wide discovery as a fallback.
- Browser automation may be used only for optional visual verification after a structured operation. It must not be the mechanism that changes FULI data.

## Selecting tools

Start from `list_agent_interfaces`; names and schemas can evolve. Common workflows and verification pairs are summarized in [workflow-recipes.md](references/workflow-recipes.md). Load that reference only when choosing or sequencing tools is not obvious from the catalog.

For read-only questions, use the narrowest list/get/search tool and return source and scope information. For writes, keep the user-requested scope explicit and verify after mutation. For multi-step operations, stop on the first failed invariant rather than continuing with a partially stale plan.

## AR questions and finding people

When the user addresses AR or Bole to ask about organization or find someone, resolve the existing dedicated AR identity and read `list_project_agents` plus `get_project_agent_coordination_policy` for the exact personal space and relevant project. Use recorded roles, assignments and team membership; do not invent an organization or recruit a replacement AR. Match names, responsibilities and capabilities, but never guess between ambiguous or duplicate names. Link each resolved name to its personal page at `/agents/{encodedPersonalSpaceId}/{encodedAgentId}`. Answering in the AR role does not mean a worker has started; report actual execution separately.

## Before starting collaborators

Read each returned worker's `context.agent.profile.allowedClients` and `executorPolicy`, together with the task's effective executor policy. Intersect the restrictions before starting either a native or external worker; the lead's selected executor does not authorize every collaborator. A locked allow-list applies even when the current host has an idle worker. If the intended platform is outside any effective lock, select an eligible Agent/executor or report the constraint before launch. Never relax the lock, relabel the worker, or invent model evidence to satisfy reporting. FULI context recovery and a ready worker plan are not execution authorization by themselves.

## Handling conflicts and failures

- On revision or timestamp conflict, re-read, explain what changed, and recompute the intended patch. Do not blindly retry stale input.
- On permission or `local_user_only` errors, identify the exact local UI action required. Do not bypass the boundary.
- On partial external sync, preserve the binding, report per-target/source failures, and let the user choose whether to retry.
- On an unknown tool or missing parity mapping, record the missing capability as a product defect instead of substituting browser automation.

## Mandatory reply identity

Every final user-visible reply MUST include the current task’s `agent_receipt.markdown` unchanged exactly once. This includes greetings, status-only replies, failures, `retain_nothing`, and capture-disabled tasks. The receipt is independent of whether a memory checkpoint was saved. Never substitute a client name, configured peer, or an earlier task’s owner. If a legacy/unavailable entry supplies no receipt, explicitly state that the FULI Agent identity is unavailable. A receipt with no authorized owner already supplies the correct neutral text.

## Completion response

State what changed, the exact project or item scope, the verification result, and any remaining human-only action. Do not claim success from a configured capability or submitted request alone.

Include the task's named durable owner and profile link from `agent_receipt` or the successful checkpoint's `conversation.receipt`. Include Jefa or other peers only with an actual `collaboration_receipt`, naming the tool work they performed; board tools do not imply a separate model worker ran. Keep this receipt brief and distinguish work completion, memory checkpoint and visible-transcript coverage. Do not report saved memory when capture failed or is disabled.

For cross-client continuation, copy the supplied continuation prompt into the same project's connected client. A leading `@Name` matches exact directory names; `@{agentId}` is the stable form (the generated prompt percent-encodes unusual IDs). Duplicate names require an exact ID in the current request; an ambiguous explicit mention must not fall back to the prior session owner or memory. This is FULI task-entry matching, not registration in a client's native @ menu. Obtain a fresh task token before `resume_agent_conversation`; never copy an old token between clients. If no qualified owner exists, route staffing through AR before implementation; Jefa remains a management peer. Preserve confirmed taste/personality/preferences and Agent character/expectations in delegated context.
