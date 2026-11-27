use std::fs;

use fuli_adapters::{
    ClientKind, inspect_all_clients, remove_setup, resolve_fuli_cli_path, run_setup,
};
use fuli_delivery::{
    compute_entry_delivery, compute_entry_delivery_opts, handle_pre_compact, record_search_delivery,
};
use fuli_domain::{
    AgentResolution, AutonomyLevel, BindingKind, BindingRole, ConstraintClass, DecisionRecord,
    HumanFeedback, KbItemStatus, KbItemType, KbLinkType, LinkAuthority, PreferenceAspect,
    ReusedRef, RuleApplicability, RuleAuthority, RuleScope, RuleStatus, SessionControlMode,
    WorkflowStatus, WorkstreamStatus, now_rfc3339,
};
use fuli_dreaming::run_layer1_scan;
use fuli_roundtable::{
    AskAgentInput, AskAgentPlan, ConciergeDispatchMode, ConciergePreviewRequest, ConciergeTask,
    ask_agent_routed, build_bot_session_ledgers, check_inbox, check_inbox_for_turn,
    prepare_ask_agent, preview_concierge_route, record_concierge_route_correction, reply_inbox,
};
use fuli_search::{IdleUnloadVectorCache, SearchOptions, search_knowledge_with_cache};
use fuli_store::{
    CheckpointInput, FuliStore, PortableExportBundle, StoreError, StoreResult, UpsertKbItemInput,
    UpsertRuleInput,
};
use serde_json::{Value, json};

pub fn handle_hook_event(
    store: &FuliStore,
    client: &str,
    event: &str,
    cwd: &str,
    session_id: Option<&str>,
    user_prompt: Option<&str>,
) -> StoreResult<(String, Value)> {
    let sess = session_id.unwrap_or("default");
    match event {
        "pre_compact" | "compact" => {
            let epoch = handle_pre_compact(store, client, sess)?;
            let summary =
                format!("FULI 已更新上下文纪元 (epoch={epoch})，下轮对话将自动重新注入生效规矩。");
            Ok((
                summary,
                json!({ "event": "pre_compact", "client": client, "session_id": sess, "context_epoch": epoch }),
            ))
        }
        "stop" => {
            let matched_agent_id = match store.resolve_agent_by_cwd(cwd).ok().map(|r| r.0) {
                Some(AgentResolution::Matched { agent, .. }) => Some(agent.id),
                _ => None,
            };
            let pending_inbox =
                check_inbox_for_turn(store, client, sess, matched_agent_id.as_deref(), 10)?;
            let summary = if pending_inbox.is_empty() {
                format!("FULI 已记录 {client} 本轮结束状态。")
            } else {
                format!("FULI 圆桌收件箱有 {} 条待回复问询。", pending_inbox.len())
            };
            Ok((
                summary,
                json!({ "event": "stop", "pending_inbox": pending_inbox }),
            ))
        }
        _ => {
            let packet = compute_entry_delivery(
                store,
                client,
                sess,
                cwd,
                None,
                None,
                user_prompt,
                "hook_prompt",
            )?;
            let summary = format_hook_summary(&packet);
            Ok((summary, serde_json::to_value(&packet)?))
        }
    }
}

fn format_hook_summary(packet: &fuli_delivery::EntryContextPacket) -> String {
    let agent_part = match &packet.agent_resolution {
        AgentResolution::Matched { agent, .. } => format!("FULI Bot: {}", agent.name),
        AgentResolution::Ambiguous { candidates, .. } => {
            format!("待确认项目 ({} 个候选)", candidates.len())
        }
        AgentResolution::Unmatched => "未绑定项目".to_string(),
    };
    let mut parts = vec![agent_part];
    if !packet.hard_rules.is_empty() {
        parts.push(format!("下发红线 {} 条", packet.hard_rules.len()));
    }
    if !packet.preferences.is_empty() {
        parts.push(format!("下发偏好 {} 条", packet.preferences.len()));
    }
    if packet.dedup_skipped_count > 0 {
        parts.push(format!("已去重跳过 {} 条", packet.dedup_skipped_count));
    }
    if !packet.rule_conflicts.is_empty() {
        parts.push(format!("发现规则冲突 {} 处", packet.rule_conflicts.len()));
    }
    if !packet.open_workstreams.is_empty() {
        parts.push(format!("进行中工作线 {} 条", packet.open_workstreams.len()));
    }
    if !packet.pending_inbox.is_empty() {
        parts.push(format!("圆桌待回复 {} 条", packet.pending_inbox.len()));
    }
    if let Some(ref hint) = packet.remember_hint {
        parts.push(hint.clone());
    }
    parts.join(" · ")
}

/// Dispatch all 13 core MCP tools cleanly against the local SQLite kernel and pluggable modules.
pub fn dispatch_tool(
    store: &FuliStore,
    vector_cache: &IdleUnloadVectorCache,
    tool: &str,
    default_client: &str,
    default_session: &str,
    args: &Value,
) -> StoreResult<Value> {
    let client = str_arg(args, &["client", "clientId"]).unwrap_or(default_client);
    let session_id = str_arg(args, &["sessionId", "session_id"]).unwrap_or(default_session);

    match tool {
        "resolve_context" => {
            let cwd = str_arg(args, &["cwd", "projectPath"]).unwrap_or(".");
            let agent_id = str_arg(args, &["agentId", "agent_id"]);
            let work_kind = str_arg(args, &["workKind", "work_kind"]);
            let user_prompt = str_arg(args, &["userPrompt", "user_prompt"]);
            let force_full = args
                .get("forceFull")
                .or_else(|| args.get("force_full"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let packet = compute_entry_delivery_opts(
                store,
                client,
                session_id,
                cwd,
                agent_id,
                work_kind,
                user_prompt,
                "mcp_resolve_context",
                force_full,
            )?;
            Ok(serde_json::to_value(packet)?)
        }

        "list_workstreams" => {
            let agent_id = match str_arg(args, &["agentId", "agent_id"]) {
                Some(id) => Some(id.to_string()),
                None => str_arg(args, &["cwd", "projectPath"]).and_then(|cwd| {
                    match store.resolve_agent_by_cwd(cwd).ok()?.0 {
                        AgentResolution::Matched { agent, .. } => Some(agent.id),
                        _ => None,
                    }
                }),
            };
            let only_open = str_arg(args, &["status"]).is_none_or(|s| s != "all");
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .min(50) as usize;
            let list = store.list_workstreams(agent_id.as_deref(), only_open)?;
            let mut items = Vec::with_capacity(list.len().min(limit));
            for ws in list.into_iter().take(limit) {
                let cp = store.latest_checkpoint_for_workstream(&ws.id)?;
                items.push(json!({
                    "workstream": ws,
                    "latest_checkpoint": cp,
                }));
            }
            Ok(json!({ "workstreams": items }))
        }

        "resume_workstream" => {
            let ws_id = str_arg(args, &["workstreamId", "workstream_id"])
                .ok_or_else(|| StoreError::InvalidInput("workstreamId is required".into()))?;
            let ws = store
                .get_workstream(ws_id)?
                .ok_or_else(|| StoreError::NotFound(format!("workstream {ws_id}")))?;
            let cp = store.latest_checkpoint_for_workstream(ws_id)?;
            store.upsert_session(
                client,
                session_id,
                Some(&ws.agent_id),
                Some(&ws.id),
                &ws.worktree_path,
                Some(&ws.title),
            )?;
            Ok(json!({
                "workstream": ws,
                "checkpoint": cp,
            }))
        }

        "checkpoint_workstream" => {
            // Respect session privacy switch: capture_paused / disabled sessions do NOT write!
            if let Some(sess) = store.get_session(client, session_id)?
                && sess.control_mode != SessionControlMode::Normal
            {
                return Ok(json!({
                    "saved": false,
                    "reason": format!("session_{}", sess.control_mode.as_str()),
                }));
            }

            let agent_id = resolve_agent_id_arg(store, args)?;
            let goal = str_arg(args, &["goal"])
                .ok_or_else(|| StoreError::InvalidInput("goal is required".into()))?
                .to_string();
            let current_state = str_arg(args, &["currentState", "current_state"])
                .unwrap_or("")
                .to_string();
            let decisions: Vec<DecisionRecord> = args
                .get("decisions")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let next_steps: Vec<String> = args
                .get("nextSteps")
                .or_else(|| args.get("next_steps"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let reused_refs: Vec<ReusedRef> = args
                .get("reusedRefs")
                .or_else(|| args.get("reused_refs"))
                .or_else(|| args.get("reliedRefs"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let (ws, cp) = store.checkpoint_workstream(CheckpointInput {
                workstream_id: str_arg(args, &["workstreamId", "workstream_id"])
                    .map(ToOwned::to_owned),
                agent_id: agent_id.clone(),
                title: str_arg(args, &["title"]).map(ToOwned::to_owned),
                status: str_arg(args, &["status"]).and_then(WorkstreamStatus::parse),
                worktree_path: str_arg(args, &["worktreePath", "worktree_path", "cwd"])
                    .map(ToOwned::to_owned),
                branch_name: str_arg(args, &["branchName", "branch_name"]).map(ToOwned::to_owned),
                goal,
                current_state,
                decisions,
                next_steps,
                reused_refs,
                source_client: client.to_string(),
                source_session_id: session_id.to_string(),
            })?;
            store.upsert_session(
                client,
                session_id,
                Some(&agent_id),
                Some(&ws.id),
                str_arg(args, &["cwd"]).unwrap_or(""),
                Some(&ws.title),
            )?;
            Ok(json!({ "saved": true, "workstream": ws, "checkpoint": cp }))
        }

        "search_knowledge" => {
            let single_q = str_arg(args, &["query"]).unwrap_or("").to_string();
            let queries: Vec<String> = args
                .get("queries")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            if single_q.trim().is_empty() && queries.is_empty() {
                return Err(StoreError::InvalidInput(
                    "query or queries is required".into(),
                ));
            }
            let item_types: Vec<KbItemType> = args
                .get("itemTypes")
                .or_else(|| args.get("item_types"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().and_then(KbItemType::parse))
                        .collect()
                })
                .unwrap_or_default();
            let agent_id = match str_arg(args, &["agentId", "agent_id"]) {
                Some(id) => Some(id.to_string()),
                None => str_arg(args, &["cwd", "projectPath"]).and_then(|cwd| {
                    match store.resolve_agent_by_cwd(cwd).ok()?.0 {
                        AgentResolution::Matched { agent, .. } => Some(agent.id),
                        _ => None,
                    }
                }),
            };
            let kb_id = str_arg(args, &["kbId", "kb_id"]).map(ToOwned::to_owned);
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let byte_budget = args
                .get("byteBudget")
                .or_else(|| args.get("byte_budget"))
                .or_else(|| args.get("budgetBytes"))
                .and_then(Value::as_u64)
                .map(|v| v as usize);
            let include_proposals = args
                .get("includeProposals")
                .or_else(|| args.get("include_proposals"))
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let result = search_knowledge_with_cache(
                store,
                &SearchOptions {
                    query: single_q,
                    queries,
                    agent_id,
                    kb_id,
                    item_types,
                    limit,
                    byte_budget,
                    include_proposals,
                    query_vector: None,
                },
                None,
                Some(vector_cache),
            )?;
            if client != "fuli-ui" && !result.hits.is_empty() {
                let pairs: Vec<(String, i64)> =
                    result.hits.iter().map(|h| (h.id.clone(), h.rev)).collect();
                let _ = record_search_delivery(
                    store,
                    client,
                    session_id,
                    &result.query,
                    &pairs,
                    result.budget.used_bytes,
                );
            }
            Ok(serde_json::to_value(result)?)
        }

        "get_knowledge_item" => {
            let item_id = str_arg(args, &["itemId", "item_id", "id"])
                .ok_or_else(|| StoreError::InvalidInput("itemId is required".into()))?;
            let item = store
                .get_kb_item(item_id)?
                .ok_or_else(|| StoreError::NotFound(format!("kb_item {item_id}")))?;
            let versions = store.list_kb_item_versions(item_id)?;
            let edges = store.list_edges_for_item(item_id)?;
            Ok(json!({
                "item": item,
                "versions": versions,
                "edges": edges,
            }))
        }

        "propose_knowledge" => {
            let kb_id = if let Some(k) = str_arg(args, &["kbId", "kb_id"]) {
                k.to_string()
            } else {
                let agent_id = resolve_agent_id_arg(store, args)?;
                store
                    .primary_kb_for_agent(&agent_id)?
                    .ok_or_else(|| StoreError::NotFound("primary kb for agent".into()))?
                    .id
            };
            let title = str_arg(args, &["title"])
                .ok_or_else(|| StoreError::InvalidInput("title is required".into()))?
                .to_string();
            let body = str_arg(args, &["body", "content"])
                .ok_or_else(|| StoreError::InvalidInput("body is required".into()))?
                .to_string();
            let item_type = str_arg(args, &["itemType", "item_type"])
                .and_then(KbItemType::parse)
                .unwrap_or(KbItemType::Fact);
            let explicit_human = args
                .get("humanExplicit")
                .or_else(|| args.get("human_explicit"))
                .or_else(|| args.get("userExplicit"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let autonomy = store.get_autonomy_level()?;
            let status = if explicit_human
                || (autonomy == AutonomyLevel::AutoRoutine && item_type == KbItemType::Fact)
            {
                KbItemStatus::Confirmed
            } else {
                KbItemStatus::Proposal
            };
            let aliases: Vec<String> = args
                .get("aliases")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let item = store.upsert_kb_item(UpsertKbItemInput {
                id: str_arg(args, &["id"]).map(ToOwned::to_owned),
                kb_id,
                stable_key: str_arg(args, &["stableKey", "stable_key"]).map(ToOwned::to_owned),
                item_type,
                status,
                lang: str_arg(args, &["lang"]).unwrap_or("zh-CN").to_string(),
                translation_of_id: str_arg(args, &["translationOfId", "translation_of_id"])
                    .map(ToOwned::to_owned),
                title,
                body,
                context_summary: str_arg(args, &["contextSummary", "context_summary"])
                    .unwrap_or("")
                    .to_string(),
                aliases,
                evidence: args.get("evidence").cloned().unwrap_or_else(|| json!({})),
                change_reason: str_arg(args, &["changeReason", "change_reason"])
                    .unwrap_or("mcp propose_knowledge")
                    .to_string(),
                changed_by: client.to_string(),
            })?;
            Ok(json!({ "item": item }))
        }

        "save_rule_or_preference" => {
            let scope_kind = str_arg(args, &["scopeKind", "scope_kind", "scope"])
                .and_then(RuleScope::parse)
                .unwrap_or(RuleScope::Agent);
            let scope_id = if scope_kind == RuleScope::Agent {
                resolve_agent_id_arg(store, args)?
            } else {
                String::new()
            };
            let constraint_class = str_arg(args, &["constraintClass", "constraint_class", "class"])
                .and_then(ConstraintClass::parse)
                .unwrap_or(ConstraintClass::Preference);
            let aspect = str_arg(args, &["aspect"])
                .and_then(PreferenceAspect::parse)
                .unwrap_or(if constraint_class == ConstraintClass::HardRule {
                    PreferenceAspect::HardRule
                } else {
                    PreferenceAspect::Taste
                });
            let pref_key = str_arg(args, &["prefKey", "pref_key", "key"])
                .unwrap_or("general")
                .to_string();
            let content = str_arg(args, &["content"])
                .ok_or_else(|| StoreError::InvalidInput("content is required".into()))?
                .to_string();
            let explicit_human = args
                .get("humanExplicit")
                .or_else(|| args.get("human_explicit"))
                .or_else(|| args.get("userExplicit"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (authority, status) = if explicit_human {
                (RuleAuthority::HumanExplicit, RuleStatus::Active)
            } else {
                (RuleAuthority::AiProposal, RuleStatus::Pending)
            };
            let work_kinds: Vec<String> = args
                .get("workKinds")
                .or_else(|| args.get("work_kinds"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let rule = store.upsert_rule_or_pref(UpsertRuleInput {
                id: str_arg(args, &["id"]).map(ToOwned::to_owned),
                scope_kind,
                scope_id,
                constraint_class,
                aspect,
                pref_key,
                authority,
                status,
                content,
                rationale: str_arg(args, &["rationale"]).unwrap_or("").to_string(),
                applicability: RuleApplicability { work_kinds },
            })?;
            Ok(json!({ "rule": rule }))
        }

        "manage_workflow" => {
            let op = str_arg(args, &["op", "action"]).unwrap_or("list");
            match op {
                "list" => {
                    let aid = str_arg(args, &["agentId", "agent_id"]);
                    let wfs = store.list_workflows(aid)?;
                    Ok(json!({ "workflows": wfs }))
                }
                "upsert" | "propose" | "create" => {
                    let agent_id = resolve_agent_id_arg(store, args)?;
                    let title = str_arg(args, &["title"])
                        .ok_or_else(|| StoreError::InvalidInput("title is required".into()))?;
                    let summary = str_arg(args, &["summary"]).unwrap_or("");
                    let steps: Vec<String> = args
                        .get("steps")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    let status = str_arg(args, &["status"])
                        .and_then(WorkflowStatus::parse)
                        .unwrap_or(WorkflowStatus::Proposed);
                    let wf = store.upsert_workflow(
                        str_arg(args, &["id"]),
                        &agent_id,
                        title,
                        summary,
                        &steps,
                        status,
                    )?;
                    Ok(json!({ "workflow": wf }))
                }
                "record_run" => {
                    let wf_id = str_arg(args, &["workflowId", "workflow_id", "id"])
                        .ok_or_else(|| StoreError::InvalidInput("workflowId is required".into()))?;
                    let passed = args.get("passed").and_then(Value::as_bool).unwrap_or(true);
                    let wf = store.record_workflow_run(wf_id, passed)?;
                    Ok(json!({ "workflow": wf }))
                }
                other => Err(StoreError::InvalidInput(format!(
                    "unknown manage_workflow op: {other}"
                ))),
            }
        }

        "session_control" => {
            let mode_raw = str_arg(args, &["mode", "action"]).unwrap_or("normal");
            if mode_raw == "pre_compact" {
                let epoch = handle_pre_compact(store, client, session_id)?;
                return Ok(json!({ "context_epoch": epoch }));
            }
            let mode = SessionControlMode::parse(mode_raw).ok_or_else(|| {
                StoreError::InvalidInput(format!("invalid control mode: {mode_raw}"))
            })?;
            let sess = store.set_session_control_mode(client, session_id, mode)?;
            Ok(json!({ "session": sess }))
        }

        "query_portfolio_summary" => {
            let days = args
                .get("sinceDays")
                .or_else(|| args.get("since_days"))
                .and_then(Value::as_u64)
                .unwrap_or(7) as u32;
            let summary = store.query_portfolio_summary(days)?;
            Ok(serde_json::to_value(summary)?)
        }

        "ask_agent" => {
            let input = parse_ask_agent_input(store, client, session_id, args)?;
            let outcome = ask_agent_routed(store, Some(vector_cache), &input)?;
            Ok(serde_json::to_value(outcome)?)
        }

        "check_inbox" => {
            if let Some(reply_id) = str_arg(args, &["replyExchangeId", "reply_exchange_id"]) {
                let answer = str_arg(args, &["answer"])
                    .ok_or_else(|| StoreError::InvalidInput("answer is required".into()))?;
                reply_inbox(store, reply_id, answer)?;
                return Ok(json!({ "replied": true, "exchange_id": reply_id }));
            }
            let only_pending = args
                .get("onlyPending")
                .or_else(|| args.get("only_pending"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let explicit_client = str_arg(args, &["targetClient", "target_client"]);
            let explicit_session = str_arg(args, &["targetSessionId", "target_session_id"]);
            let agent_id = match str_arg(args, &["agentId", "agent_id"]) {
                Some(id) => Some(id.to_string()),
                None => str_arg(args, &["cwd", "projectPath"]).and_then(|cwd| {
                    match store.resolve_agent_by_cwd(cwd).ok()?.0 {
                        AgentResolution::Matched { agent, .. } => Some(agent.id),
                        _ => None,
                    }
                }),
            };
            let items = if only_pending && explicit_client.is_none() && explicit_session.is_none() {
                check_inbox_for_turn(store, client, session_id, agent_id.as_deref(), 20)?
            } else {
                let target_client = explicit_client.or(Some(client));
                let target_session = if explicit_client.is_some() {
                    explicit_session
                } else {
                    explicit_session.or(Some(session_id))
                };
                check_inbox(store, target_client, target_session, only_pending)?
            };
            Ok(json!({ "exchanges": items }))
        }

        // Utility CLI/management tools
        "register_agent" => {
            let name = str_arg(args, &["name"])
                .ok_or_else(|| StoreError::InvalidInput("name is required".into()))?;
            let description = str_arg(args, &["description"]).unwrap_or("");
            let reply_lang = str_arg(args, &["replyLang", "reply_lang"]).unwrap_or("zh-CN");
            let persona_note = str_arg(args, &["personaNote", "persona_note"]).unwrap_or("");
            let agent = store.create_agent(name, description, reply_lang, persona_note)?;
            if let Some(remote) = str_arg(args, &["gitRemote", "git_remote"]) {
                store.bind_agent(
                    &agent.id,
                    BindingKind::GitRemote,
                    remote,
                    BindingRole::Own,
                    "origin",
                )?;
            }
            if let Some(dir) = str_arg(args, &["dirPath", "dir_path", "cwd"]) {
                store.bind_agent(
                    &agent.id,
                    BindingKind::DirPath,
                    dir,
                    BindingRole::Own,
                    "local",
                )?;
            }
            let primary_kb = store.primary_kb_for_agent(&agent.id)?;
            Ok(json!({ "agent": agent, "primary_kb": primary_kb }))
        }

        "run_dreaming" => {
            let report = run_layer1_scan(store)?;
            Ok(serde_json::to_value(report)?)
        }

        "export_portable" => {
            let bundle = store.export_portable_bundle()?;
            Ok(serde_json::to_value(bundle)?)
        }

        "import_portable" => {
            let dry_run = args
                .get("dryRun")
                .or_else(|| args.get("dry_run"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let raw = args
                .get("bundle")
                .ok_or_else(|| StoreError::InvalidInput("bundle is required".into()))?;
            let bundle: PortableExportBundle = serde_json::from_value(raw.clone())?;
            let summary = store.import_portable_bundle(&bundle, dry_run)?;
            Ok(serde_json::to_value(summary)?)
        }

        "import_v1_json" => {
            let dry_run = args
                .get("dryRun")
                .or_else(|| args.get("dry_run"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let raw_json = str_arg(args, &["rawJson", "raw_json"])
                .ok_or_else(|| StoreError::InvalidInput("rawJson is required".into()))?;
            let summary = store.import_v1_export_json(raw_json, dry_run)?;
            Ok(serde_json::to_value(summary)?)
        }

        other => Err(StoreError::InvalidInput(format!("unknown tool: {other}"))),
    }
}

/// Build the complete live data snapshot consumed by `fuli-ui` over local IPC.
pub fn build_dashboard_snapshot(
    store: &FuliStore,
    vector_cache: &IdleUnloadVectorCache,
    concierge_tasks: &[ConciergeTask],
) -> StoreResult<Value> {
    let portfolio = store.query_portfolio_summary(7)?;
    let agents = store.list_agents(false)?;
    let mut agent_cards = Vec::with_capacity(agents.len());
    for a in &agents {
        let bindings = store.list_agent_bindings(&a.id)?;
        let mounts = store.list_agent_mounts(&a.id)?;
        let auth_kbs = store.authorized_kbs_for_agent(&a.id)?;
        agent_cards.push(json!({
            "agent": a,
            "bindings": bindings,
            "mounts": mounts,
            "authorized_kbs": auth_kbs,
        }));
    }

    let kbs = store.list_kbs()?;
    let kb_links = store.list_kb_links()?;
    let kb_items = store.list_kb_items(None, None)?;
    let rules = store.list_rules_for_context(None)?;
    let rule_conflicts = store.list_all_rule_conflicts()?;
    let pending = store.list_pending_items()?;
    let workstreams = store.list_workstreams(None, false)?;
    let workflows = store.list_workflows(None)?;
    let sessions = store.list_sessions(30)?;
    let deliveries = store.list_recent_deliveries(40)?;
    let tokens_saved = store.total_tokens_saved_by_dedup()?;
    let roundtable = store.list_roundtable_exchanges(None, None, false, 30)?;
    let bot_session_ledgers = build_bot_session_ledgers(store)?;
    let dreaming = run_layer1_scan(store)?;
    let autonomy_level = store.get_autonomy_level()?;
    let ui_locale = store
        .get_setting("ui_locale")?
        .unwrap_or_else(|| "zh-CN".to_string());
    let clients = inspect_all_clients();
    let vector_stats = vector_cache.stats();

    Ok(json!({
        "portfolio": portfolio,
        "agents": agent_cards,
        "knowledge_bases": kbs,
        "kb_links": kb_links,
        "kb_items": kb_items,
        "rules": rules,
        "rule_conflicts": rule_conflicts,
        "pending": pending,
        "workstreams": workstreams,
        "workflows": workflows,
        "sessions": sessions,
        "deliveries": deliveries,
        "tokens_saved": tokens_saved,
        "roundtable": roundtable,
        "bot_session_ledgers": bot_session_ledgers,
        "concierge_tasks": concierge_tasks,
        "dreaming": dreaming,
        "autonomy_level": autonomy_level,
        "ui_locale": ui_locale,
        "clients": clients,
        "vector_cache": vector_stats,
    }))
}

/// Handle 1-click UI actions sent from `fuli-ui` over IPC.
pub fn handle_ui_action(
    store: &FuliStore,
    vector_cache: &IdleUnloadVectorCache,
    action: &str,
    payload: &Value,
) -> StoreResult<Value> {
    match action {
        "confirm_kb_item" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let item = store.set_kb_item_status(
                id,
                KbItemStatus::Confirmed,
                "用户在工作台一键确认",
                "human",
            )?;
            Ok(json!({ "item": item }))
        }
        "deprecate_kb_item" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let item = store.set_kb_item_status(
                id,
                KbItemStatus::Deprecated,
                "用户在工作台一键废弃",
                "human",
            )?;
            Ok(json!({ "item": item }))
        }
        "feedback_kb_item" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let fb = str_arg(payload, &["feedback"])
                .and_then(HumanFeedback::parse)
                .unwrap_or(HumanFeedback::Helpful);
            let item = store.apply_kb_feedback(id, fb)?;
            Ok(json!({ "item": item }))
        }
        "promote_kb_to_hard_rule" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let item = store
                .get_kb_item(id)?
                .ok_or_else(|| StoreError::NotFound(format!("kb_item {id}")))?;
            let scope_id = str_arg(payload, &["agent_id"]).unwrap_or("");
            let scope_kind = if scope_id.is_empty() {
                RuleScope::PersonalGlobal
            } else {
                RuleScope::Agent
            };
            let pref_key = item
                .stable_key
                .clone()
                .unwrap_or_else(|| format!("kb.{}", item.id.chars().take(8).collect::<String>()));
            let rule = store.upsert_rule_or_pref(UpsertRuleInput {
                id: None,
                scope_kind,
                scope_id: scope_id.to_string(),
                constraint_class: ConstraintClass::HardRule,
                aspect: PreferenceAspect::HardRule,
                pref_key,
                authority: RuleAuthority::HumanConfirmed,
                status: RuleStatus::Active,
                content: format!("{}：{}", item.title, item.body),
                rationale: "由已确认知识条目一键升格为红线规矩".into(),
                applicability: RuleApplicability::default(),
            })?;
            Ok(json!({ "rule": rule }))
        }
        "approve_rule" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let promote = payload
                .get("promote_to_hard")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rule = store.approve_rule(id, promote)?;
            Ok(json!({ "rule": rule }))
        }
        "disable_rule" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let rule = store.disable_rule(id)?;
            Ok(json!({ "rule": rule }))
        }
        "resolve_conflict" => {
            let winner_id = str_arg(payload, &["winner_id"])
                .ok_or_else(|| StoreError::InvalidInput("winner_id is required".into()))?;
            let loser_ids: Vec<String> = payload
                .get("loser_ids")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            store.resolve_rule_conflict(winner_id, &loser_ids)?;
            Ok(json!({ "resolved": true }))
        }
        "approve_workflow" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let wf = store
                .get_workflow(id)?
                .ok_or_else(|| StoreError::NotFound(format!("workflow {id}")))?;
            let updated = store.upsert_workflow(
                Some(&wf.id),
                &wf.agent_id,
                &wf.title,
                &wf.summary,
                &wf.steps,
                WorkflowStatus::Active,
            )?;
            Ok(json!({ "workflow": updated }))
        }
        "toggle_kb_link" => {
            let from_kb_id = str_arg(payload, &["from_kb_id"])
                .ok_or_else(|| StoreError::InvalidInput("from_kb_id is required".into()))?;
            let to_kb_id = str_arg(payload, &["to_kb_id"])
                .ok_or_else(|| StoreError::InvalidInput("to_kb_id is required".into()))?;
            let enable = payload
                .get("enable")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let authority = if enable {
                LinkAuthority::HumanConfirmed
            } else {
                LinkAuthority::Revoked
            };
            let link = store.upsert_kb_link(
                from_kb_id,
                to_kb_id,
                KbLinkType::Cites,
                authority,
                0.9,
                "用户在知识库页切换授权",
            )?;
            Ok(json!({ "link": link }))
        }
        "set_autonomy_level" => {
            let raw = str_arg(payload, &["level"]).unwrap_or("manual");
            let level = match raw {
                "assist" => AutonomyLevel::Assist,
                "auto_routine" => AutonomyLevel::AutoRoutine,
                _ => AutonomyLevel::Manual,
            };
            store.set_autonomy_level(level)?;
            Ok(json!({ "autonomy_level": level }))
        }
        "set_locale" => {
            let locale = str_arg(payload, &["locale"]).unwrap_or("zh-CN");
            store.set_setting("ui_locale", locale)?;
            Ok(json!({ "ui_locale": locale }))
        }
        "setup_client" => {
            let raw = str_arg(payload, &["client"])
                .ok_or_else(|| StoreError::InvalidInput("client is required".into()))?;
            let client = ClientKind::parse(raw)
                .ok_or_else(|| StoreError::InvalidInput(format!("unsupported client: {raw}")))?;
            let bin = resolve_fuli_cli_path(None);
            let plan = run_setup(client, None, &bin, true).map_err(StoreError::InvalidInput)?;
            Ok(serde_json::to_value(plan)?)
        }
        "remove_client" => {
            let raw = str_arg(payload, &["client"])
                .ok_or_else(|| StoreError::InvalidInput("client is required".into()))?;
            let client = ClientKind::parse(raw)
                .ok_or_else(|| StoreError::InvalidInput(format!("unsupported client: {raw}")))?;
            let plan = remove_setup(client, None, true).map_err(StoreError::InvalidInput)?;
            Ok(serde_json::to_value(plan)?)
        }
        "export_to_file" => {
            let bundle = store.export_portable_bundle()?;
            let base_dir = store
                .db_path()
                .and_then(|p| p.parent())
                .map(ToOwned::to_owned)
                .unwrap_or_else(std::env::temp_dir);
            let export_dir = base_dir.join("exports");
            fs::create_dir_all(&export_dir)?;
            let stamp = now_rfc3339().replace(':', "-");
            let out_path = export_dir.join(format!("fuli-export-{stamp}.json"));
            let pretty = serde_json::to_string_pretty(&bundle)?;
            fs::write(&out_path, pretty)?;
            Ok(json!({
                "path": out_path.display().to_string(),
                "agents": bundle.agents.len(),
                "items": bundle.kb_items.len(),
                "rules": bundle.rules_and_prefs.len(),
            }))
        }
        "run_dreaming" => {
            let report = run_layer1_scan(store)?;
            Ok(serde_json::to_value(report)?)
        }
        "search_knowledge" => dispatch_tool(
            store,
            vector_cache,
            "search_knowledge",
            "fuli-ui",
            "ui",
            payload,
        ),
        "get_knowledge_item" => dispatch_tool(
            store,
            vector_cache,
            "get_knowledge_item",
            "fuli-ui",
            "ui",
            payload,
        ),
        "create_agent" => dispatch_tool(
            store,
            vector_cache,
            "register_agent",
            "fuli-ui",
            "ui",
            payload,
        ),
        "create_kb_item" => dispatch_tool(
            store,
            vector_cache,
            "propose_knowledge",
            "fuli-ui",
            "ui",
            payload,
        ),
        "create_rule" => dispatch_tool(
            store,
            vector_cache,
            "save_rule_or_preference",
            "fuli-ui",
            "ui",
            payload,
        ),
        "ask_agent" => dispatch_tool(store, vector_cache, "ask_agent", "fuli-ui", "ui", payload),
        "concierge_preview" => {
            let req = parse_concierge_preview_request(payload)?;
            let preview = preview_concierge_route(store, Some(vector_cache), &req)?;
            Ok(serde_json::to_value(preview)?)
        }
        "concierge_correct_route" => {
            let prompt = str_arg(payload, &["prompt"])
                .ok_or_else(|| StoreError::InvalidInput("prompt is required".into()))?;
            let agent_id = str_arg(payload, &["agent_id", "agentId"])
                .ok_or_else(|| StoreError::InvalidInput("agent_id is required".into()))?;
            let learned = record_concierge_route_correction(store, prompt, agent_id)?;
            Ok(json!({ "saved": true, "learned_terms": learned, "agent_id": agent_id }))
        }
        "reply_roundtable" => {
            let id = str_arg(payload, &["id"])
                .ok_or_else(|| StoreError::InvalidInput("id is required".into()))?;
            let answer = str_arg(payload, &["answer"])
                .ok_or_else(|| StoreError::InvalidInput("answer is required".into()))?;
            reply_inbox(store, id, answer)?;
            Ok(json!({ "replied": true }))
        }
        other => Err(StoreError::InvalidInput(format!(
            "unknown UI action: {other}"
        ))),
    }
}

/// Parse Concierge route preview/dispatch payload from `fuli-ui`.
pub fn parse_concierge_preview_request(payload: &Value) -> StoreResult<ConciergePreviewRequest> {
    let prompt = str_arg(payload, &["prompt", "question"])
        .ok_or_else(|| StoreError::InvalidInput("prompt is required".into()))?
        .to_string();
    let override_agent_id = str_arg(
        payload,
        &[
            "override_agent_id",
            "overrideAgentId",
            "agent_id",
            "agentId",
        ],
    )
    .map(ToOwned::to_owned);
    let override_client = str_arg(
        payload,
        &["override_client", "overrideClient", "client", "toClient"],
    )
    .map(ToOwned::to_owned);
    let override_session_id = str_arg(
        payload,
        &[
            "override_session_id",
            "overrideSessionId",
            "session_id",
            "toSessionId",
        ],
    )
    .map(ToOwned::to_owned);
    let override_mode = str_arg(payload, &["override_mode", "overrideMode", "mode"])
        .and_then(ConciergeDispatchMode::parse);
    Ok(ConciergePreviewRequest {
        prompt,
        override_agent_id,
        override_client,
        override_session_id,
        override_mode,
    })
}

/// Parse MCP/UI arguments into `AskAgentInput` and produce a lock-free `AskAgentPlan`.
pub fn prepare_ask_agent_request(
    store: &FuliStore,
    vector_cache: &IdleUnloadVectorCache,
    default_client: &str,
    default_session: &str,
    args: &Value,
) -> StoreResult<AskAgentPlan> {
    let client = str_arg(args, &["client", "clientId"]).unwrap_or(default_client);
    let session_id = str_arg(args, &["sessionId", "session_id"]).unwrap_or(default_session);
    let input = parse_ask_agent_input(store, client, session_id, args)?;
    prepare_ask_agent(store, Some(vector_cache), &input)
}

fn parse_ask_agent_input(
    store: &FuliStore,
    client: &str,
    session_id: &str,
    args: &Value,
) -> StoreResult<AskAgentInput> {
    let to_client = str_arg(args, &["toClient", "to_client"])
        .ok_or_else(|| StoreError::InvalidInput("toClient is required".into()))?
        .to_string();
    let to_session_id = str_arg(args, &["toSessionId", "to_session_id"])
        .unwrap_or("*")
        .to_string();
    let question = str_arg(args, &["question"])
        .ok_or_else(|| StoreError::InvalidInput("question is required".into()))?
        .to_string();
    let force_wake = args
        .get("forceWake")
        .or_else(|| args.get("force_wake"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow_memory_fast_path = if force_wake {
        false
    } else {
        args.get("allowMemoryFastPath")
            .or_else(|| args.get("allow_memory_fast_path"))
            .and_then(Value::as_bool)
            .unwrap_or(true)
    };
    let attempt_native_wake = args
        .get("attemptNativeWake")
        .or_else(|| args.get("attempt_native_wake"))
        .and_then(Value::as_bool)
        .unwrap_or(force_wake);
    let wake_timeout_ms = args
        .get("wakeTimeoutMs")
        .or_else(|| args.get("wake_timeout_ms"))
        .and_then(Value::as_u64);
    let agent_id = match str_arg(args, &["agentId", "agent_id"]) {
        Some(id) => Some(id.to_string()),
        None => str_arg(args, &["cwd", "projectPath"]).and_then(|cwd| {
            match store.resolve_agent_by_cwd(cwd).ok()?.0 {
                AgentResolution::Matched { agent, .. } => Some(agent.id),
                _ => None,
            }
        }),
    };
    Ok(AskAgentInput {
        agent_id,
        from_client: client.to_string(),
        from_session_id: session_id.to_string(),
        to_client,
        to_session_id,
        question,
        allow_memory_fast_path,
        attempt_native_wake,
        wake_timeout_ms,
    })
}

fn str_arg<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = args.get(*k).and_then(Value::as_str)
            && !s.trim().is_empty()
        {
            return Some(s);
        }
    }
    None
}

fn resolve_agent_id_arg(store: &FuliStore, args: &Value) -> StoreResult<String> {
    if let Some(id) = str_arg(args, &["agentId", "agent_id"]) {
        return Ok(id.to_string());
    }
    if let Some(cwd) = str_arg(args, &["cwd", "projectPath"]) {
        let (res, _) = store.resolve_agent_by_cwd(cwd)?;
        if let AgentResolution::Matched { agent, .. } = res {
            return Ok(agent.id);
        }
    }
    Err(StoreError::InvalidInput(
        "agentId or a bound cwd is required".into(),
    ))
}
