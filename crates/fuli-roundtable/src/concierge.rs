//! FULI Concierge ("FULI 大管家") — Single-Entry Multi-Bot & Multi-Session Commander.
//!
//! Responsibilities:
//! - Remembers every FULI Bot's recent `session_id`s across all connected clients (`claude-code`,
//!   `codex`, `opencode`, `cursor`) and imports existing on-disk local sessions safely read-only.
//! - Deterministically previews which FULI Bot + Client + latest `session_id` + repo `cwd` should
//!   handle a user request (<3ms, 0 LLM tokens) BEFORE executing, so the user can verify or correct
//!   in 1 click.
//! - Learns from user route corrections (`concierge_route_hints` in local `settings`).
//! - Supports seamless cross-client switching on any FULI Bot by packing a compact Handoff Brief
//!   (active hard rules + preferences + latest workstream checkpoint — zero raw chat dump!) and
//!   launching a fresh CLI session in the Bot's bound `cwd` when needed.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use fuli_adapters::{discover_local_sessions, is_client_cli_available};
use fuli_domain::{
    AgentResolution, BindingKind, FuliAgent, SessionRecord, WakeStatus, now_rfc3339,
};
use fuli_search::IdleUnloadVectorCache;
use fuli_store::{FuliStore, StoreResult, tokenize_query_terms};
use serde::{Deserialize, Serialize};

use crate::{
    AskAgentInput, AskAgentPlan, build_native_wake_command_opts, prepare_ask_agent,
    try_memory_fast_path,
};

const ROUTE_HINTS_SETTING_KEY: &str = "concierge_route_hints";
const SUPPORTED_CLIENTS: [&str; 4] = ["claude-code", "codex", "opencode", "cursor"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConciergeDispatchMode {
    /// Instant 0-token answer from FULI memory / checkpoints or global multi-bot overview.
    MemoryAnswer,
    /// Resume target FULI Bot's latest native CLI session (`--resume` / `exec resume` / `--session`).
    ResumeLatestSession,
    /// Switch target FULI Bot to another execution client with a compact cross-client Handoff Brief.
    SwitchClientHandoff,
    /// Queue honestly in target client's local inbox (piggybacked on next Hook/MCP turn).
    QueueClientInbox,
}

impl ConciergeDispatchMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_lowercase().as_str() {
            "memory_answer" | "memory" => Some(Self::MemoryAnswer),
            "resume_latest_session" | "resume" => Some(Self::ResumeLatestSession),
            "switch_client_handoff" | "handoff" | "switch" => Some(Self::SwitchClientHandoff),
            "queue_client_inbox" | "inbox" => Some(Self::QueueClientInbox),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConciergeTaskStatus {
    Queued,
    Running,
    Completed,
    NeedsAttention,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSessionDigest {
    pub client_id: String,
    pub session_id: String,
    pub cwd: String,
    pub summary: String,
    pub last_seen_at: String,
    pub supports_native_resume: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotSessionLedger {
    pub agent_id: String,
    pub agent_name: String,
    pub description: String,
    pub latest_session: Option<BotSessionDigest>,
    #[serde(default)]
    pub recent_sessions: Vec<BotSessionDigest>,
    #[serde(default)]
    pub active_workstream_title: Option<String>,
    #[serde(default)]
    pub active_workstream_state: Option<String>,
    pub open_workstream_count: usize,
    pub active_rule_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BotRouteCandidate {
    pub agent_id: String,
    pub agent_name: String,
    pub score: u32,
    pub latest_client: Option<String>,
    pub latest_session_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConciergePreviewRequest {
    pub prompt: String,
    #[serde(default)]
    pub override_agent_id: Option<String>,
    #[serde(default)]
    pub override_client: Option<String>,
    #[serde(default)]
    pub override_session_id: Option<String>,
    #[serde(default)]
    pub override_mode: Option<ConciergeDispatchMode>,
    /// Explicit write opt-in (default false = safe read-only sandbox).
    #[serde(default)]
    pub allow_write: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConciergeRoutePreview {
    pub prompt: String,
    pub is_global_overview: bool,
    pub selected_agent_id: Option<String>,
    pub selected_agent_name: String,
    pub auto_detected: bool,
    pub confidence: u8,
    pub reason: String,
    #[serde(default)]
    pub candidate_bots: Vec<BotRouteCandidate>,
    pub target_client: String,
    pub target_session_id: String,
    pub target_session_summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub client_cli_available: bool,
    #[serde(default)]
    pub allow_write: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switched_from_client: Option<String>,
    #[serde(default)]
    pub available_clients: Vec<String>,
    pub mode: ConciergeDispatchMode,
    pub can_answer_from_memory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_brief_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConciergeTask {
    pub id: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub target_client: String,
    pub target_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switched_from_client: Option<String>,
    pub mode: ConciergeDispatchMode,
    pub status: ConciergeTaskStatus,
    pub step_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exchange_id: Option<String>,
    #[serde(default)]
    pub was_corrected: bool,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSessionsSummary {
    pub scanned: usize,
    pub imported: usize,
    pub matched_bots: usize,
}

/// Scan local Claude Code / Codex / OpenCode session metadata files (read-only) and sync them
/// into `fuli.db` `sessions`, auto-attaching each session to its matching FULI Bot by `cwd`.
pub fn sync_local_sessions_into_store(
    store: &FuliStore,
    limit: usize,
) -> StoreResult<SyncSessionsSummary> {
    let discovered = discover_local_sessions(limit);
    let mut imported = 0usize;
    let mut matched_bots = 0usize;

    for s in &discovered {
        let matched_agent_id = match store.resolve_agent_by_cwd(&s.cwd).ok().map(|r| r.0) {
            Some(AgentResolution::Matched { agent, .. }) => {
                matched_bots += 1;
                Some(agent.id)
            }
            _ => None,
        };
        let existed = store.get_session(&s.client_id, &s.session_id)?.is_some();
        store.upsert_session(
            &s.client_id,
            &s.session_id,
            matched_agent_id.as_deref(),
            None,
            &s.cwd,
            Some(&s.summary),
        )?;
        if !existed {
            imported += 1;
        }
    }

    Ok(SyncSessionsSummary {
        scanned: discovered.len(),
        imported,
        matched_bots,
    })
}

/// Merge live in-memory `ConciergeTask` entries with persisted `fuli-concierge` exchanges in SQLite
/// so Concierge dispatch history survives daemon restarts cleanly without schema changes.
pub fn hydrate_persisted_concierge_tasks(
    store: &FuliStore,
    live_tasks: &[ConciergeTask],
    limit: usize,
) -> StoreResult<Vec<ConciergeTask>> {
    let mut merged: Vec<ConciergeTask> = live_tasks.to_vec();
    let seen_exchanges: HashSet<String> = live_tasks
        .iter()
        .filter_map(|t| t.exchange_id.clone())
        .collect();

    let agents = store.list_agents(false)?;
    let agent_names: HashMap<String, String> = agents.into_iter().map(|a| (a.id, a.name)).collect();

    let persisted = store.list_roundtable_exchanges(None, None, false, limit.max(20))?;
    for ex in persisted {
        if ex.from_client != "fuli-concierge" || seen_exchanges.contains(&ex.id) {
            continue;
        }
        let agent_name = ex
            .agent_id
            .as_ref()
            .and_then(|aid| agent_names.get(aid))
            .cloned()
            .unwrap_or_else(|| {
                if ex.to_client == "fuli-concierge" {
                    "全局所有项目".to_string()
                } else {
                    "未绑定项目".to_string()
                }
            });
        let (mode, status, step_label) = if ex.to_client == "fuli-concierge" {
            (
                ConciergeDispatchMode::MemoryAnswer,
                ConciergeTaskStatus::Completed,
                "历史全局汇总（0 Token）".to_string(),
            )
        } else if ex.wake_status == WakeStatus::WokenReplied {
            let is_mem = ex
                .answer
                .as_deref()
                .is_some_and(|a| a.contains("FULI 记忆直答"));
            if is_mem {
                (
                    ConciergeDispatchMode::MemoryAnswer,
                    ConciergeTaskStatus::Completed,
                    "历史记忆直答（0 Token）".to_string(),
                )
            } else {
                (
                    ConciergeDispatchMode::ResumeLatestSession,
                    ConciergeTaskStatus::Completed,
                    format!("{} 已回复", client_display_name(&ex.to_client)),
                )
            }
        } else {
            (
                ConciergeDispatchMode::QueueClientInbox,
                ConciergeTaskStatus::NeedsAttention,
                format!("待 {} 下轮自动捎带", client_display_name(&ex.to_client)),
            )
        };

        let clean_prompt = if let Some((_, tail)) = ex.question.split_once("[用户新指令]\n") {
            tail.trim().to_string()
        } else {
            ex.question.clone()
        };

        merged.push(ConciergeTask {
            id: format!("hist-{}", ex.id),
            prompt: clean_prompt,
            agent_id: ex.agent_id,
            agent_name,
            target_client: ex.to_client,
            target_session_id: ex.to_session_id,
            switched_from_client: None,
            mode,
            status,
            step_label,
            result_preview: ex.answer,
            exchange_id: Some(ex.id),
            was_corrected: false,
            started_at: ex.created_at,
            finished_at: ex.answered_at,
            elapsed_ms: 0,
        });
        if merged.len() >= limit {
            break;
        }
    }

    Ok(merged)
}

/// Inspect every active FULI Bot along with its recent sessions across clients and latest checkpoint.
pub fn build_bot_session_ledgers(store: &FuliStore) -> StoreResult<Vec<BotSessionLedger>> {
    let agents = store.list_agents(false)?;
    let sessions = store.list_sessions(80)?;
    let all_rules = store.list_rules_for_context(None)?;

    let mut sessions_by_agent: HashMap<String, Vec<SessionRecord>> = HashMap::new();
    for s in sessions {
        if let Some(ref aid) = s.agent_id {
            sessions_by_agent.entry(aid.clone()).or_default().push(s);
        }
    }

    let mut ledgers = Vec::with_capacity(agents.len());
    for agent in agents {
        let open_ws = store.list_workstreams(Some(&agent.id), true)?;
        let (ws_title, ws_state) = if let Some(first) = open_ws.first() {
            let cp = store.latest_checkpoint_for_workstream(&first.id)?;
            (
                Some(first.title.clone()),
                cp.map(|c| {
                    if !c.current_state.trim().is_empty() {
                        c.current_state
                    } else {
                        c.goal
                    }
                }),
            )
        } else {
            (None, None)
        };

        let active_rule_count = all_rules
            .iter()
            .filter(|r| {
                r.status == fuli_domain::RuleStatus::Active
                    && (r.scope_id == agent.id || r.scope_id.is_empty())
            })
            .count();

        let agent_sessions = sessions_by_agent.remove(&agent.id).unwrap_or_default();
        let digests: Vec<BotSessionDigest> = agent_sessions
            .into_iter()
            .take(5)
            .map(|s| {
                let summary = if !s.last_summary.trim().is_empty() {
                    s.last_summary.clone()
                } else if let Some(ref t) = ws_title {
                    format!("工作线：{t}")
                } else if !s.cwd.trim().is_empty() {
                    format!("目录：{}", short_dir_name(&s.cwd))
                } else {
                    "最近活跃会话".to_string()
                };
                let supports_native_resume = build_native_wake_command_opts(
                    &s.client_id,
                    &s.session_id,
                    "ping",
                    false,
                    false,
                )
                .is_some();
                BotSessionDigest {
                    client_id: s.client_id,
                    session_id: s.session_id,
                    cwd: s.cwd,
                    summary,
                    last_seen_at: s.updated_at,
                    supports_native_resume,
                }
            })
            .collect();

        let latest_session = digests.first().cloned();
        ledgers.push(BotSessionLedger {
            agent_id: agent.id,
            agent_name: agent.name,
            description: agent.description,
            latest_session,
            recent_sessions: digests,
            active_workstream_title: ws_title,
            active_workstream_state: ws_state,
            open_workstream_count: open_ws.len(),
            active_rule_count,
        });
    }

    // Sort Bots with freshest active sessions first so the radar feels alive
    ledgers.sort_by(|a, b| {
        let ta = a
            .latest_session
            .as_ref()
            .map(|s| s.last_seen_at.as_str())
            .unwrap_or("");
        let tb = b
            .latest_session
            .as_ref()
            .map(|s| s.last_seen_at.as_str())
            .unwrap_or("");
        tb.cmp(ta).then_with(|| a.agent_name.cmp(&b.agent_name))
    });

    Ok(ledgers)
}

/// Preview how the FULI Concierge will route a user utterance BEFORE executing it.
/// Runs in <3ms with 0 LLM tokens, allowing the user to verify or correct target Bot/Client/Session.
pub fn preview_concierge_route(
    store: &FuliStore,
    vector_cache: Option<&IdleUnloadVectorCache>,
    req: &ConciergePreviewRequest,
) -> StoreResult<ConciergeRoutePreview> {
    let prompt = req.prompt.trim().to_string();
    let ledgers = build_bot_session_ledgers(store)?;
    let agents = store.list_agents(false)?;
    let hints = load_route_hints(store);
    let is_global_overview = req.override_agent_id.is_none() && looks_like_global_overview(&prompt);

    // 1. Score every FULI Bot against the prompt (name, repo dir, workstream, learned hints, recency)
    let mut candidates = score_bot_candidates(store, &agents, &ledgers, &hints, &prompt)?;

    // 2. Select Bot (explicit user override takes priority over auto-detection)
    let (selected_ledger, auto_detected, confidence, reason) =
        if let Some(ref oid) = req.override_agent_id {
            let found = ledgers
                .iter()
                .find(|l| l.agent_id == *oid || l.agent_name.eq_ignore_ascii_case(oid))
                .cloned();
            match found {
                Some(l) => (
                    Some(l),
                    false,
                    100u8,
                    "已按你手动指定的 FULI Bot 锁定路由".to_string(),
                ),
                None => (None, false, 0u8, "指定的 FULI Bot 不存在".to_string()),
            }
        } else if is_global_overview {
            (
                None,
                true,
                95u8,
                "识别为跨项目全局状态汇总，大管家可直接零成本汇总所有 Bot 与会话".to_string(),
            )
        } else if let Some(top) = candidates.first() {
            let found = ledgers.iter().find(|l| l.agent_id == top.agent_id).cloned();
            let second_score = candidates.get(1).map(|c| c.score).unwrap_or(0);
            let conf = if top.score >= 60 && top.score >= second_score + 20 {
                92
            } else if top.score >= 30 {
                76
            } else {
                55
            };
            (found, true, conf, top.reason.clone())
        } else {
            (
                None,
                true,
                40u8,
                "当前还没有已注册的 FULI Bot，可先在项目页添加或直接查询全局记忆".to_string(),
            )
        };

    // Keep top 6 candidates for 1-click correction bar
    candidates.truncate(6);

    // 3. Determine target client + latest session_id + working_dir for the selected FULI Bot
    let mentioned_client = detect_client_mention(&prompt);
    let latest_bot_sess = selected_ledger
        .as_ref()
        .and_then(|l| l.latest_session.clone());

    // What the user named (in the picker or the prompt) is kept even if it is not installed,
    // so the preview can say so. An automatic guess falls back to an installed client.
    let explicit_client = req
        .override_client
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(normalize_client_name)
        .or(mentioned_client);
    let (target_client, unavailable_client) = pick_target_client(
        explicit_client,
        latest_bot_sess
            .as_ref()
            .map(|s| normalize_client_name(&s.client_id)),
        is_client_cli_available,
    );
    let reason = match unavailable_client {
        Some(ref missing) => format!(
            "{reason}；这台电脑上找不到 {}，改用 {}",
            client_display_name(missing),
            client_display_name(&target_client)
        ),
        None => reason,
    };

    let matched_client_sess = selected_ledger.as_ref().and_then(|l| {
        l.recent_sessions
            .iter()
            .find(|s| normalize_client_name(&s.client_id) == target_client)
            .cloned()
    });

    let (target_session_id, target_session_summary) = if let Some(ref osid) =
        req.override_session_id
        && !osid.trim().is_empty()
    {
        let desc = selected_ledger
            .as_ref()
            .and_then(|l| l.recent_sessions.iter().find(|s| s.session_id == *osid))
            .map(|s| s.summary.clone())
            .unwrap_or_else(|| "手动选定会话".to_string());
        (osid.clone(), desc)
    } else if let Some(ref s) = matched_client_sess {
        (s.session_id.clone(), s.summary.clone())
    } else {
        (
            "*".to_string(),
            "该客户端暂无历史会话，将启动新接力会话并记住其 ID".to_string(),
        )
    };

    let working_dir = resolve_bot_working_dir(
        store,
        selected_ledger.as_ref(),
        matched_client_sess.as_ref(),
    );
    let client_cli_available = is_client_cli_available(&target_client);

    let switched_from_client = latest_bot_sess.as_ref().and_then(|latest| {
        let prev = normalize_client_name(&latest.client_id);
        if prev != target_client {
            Some(prev)
        } else {
            None
        }
    });

    // 4. Pre-check Tier 0 memory fast-path (<3ms) so the preview tells the user honestly
    let can_answer_from_memory = if is_global_overview {
        true
    } else if !prompt.is_empty() {
        try_memory_fast_path(
            store,
            vector_cache,
            selected_ledger.as_ref().map(|l| l.agent_id.as_str()),
            &prompt,
        )?
        .is_some()
    } else {
        false
    };

    // 5. Pick dispatch mode (or respect user override)
    let supports_native_cmd = build_native_wake_command_opts(
        &target_client,
        &target_session_id,
        &prompt,
        true,
        req.allow_write,
    )
    .is_some();

    let mode = if let Some(om) = req.override_mode {
        om
    } else if is_global_overview {
        ConciergeDispatchMode::MemoryAnswer
    } else if switched_from_client.is_some() {
        ConciergeDispatchMode::SwitchClientHandoff
    } else if can_answer_from_memory && !looks_like_explicit_execution(&prompt) {
        ConciergeDispatchMode::MemoryAnswer
    } else if supports_native_cmd {
        ConciergeDispatchMode::ResumeLatestSession
    } else {
        ConciergeDispatchMode::QueueClientInbox
    };

    // 6. If switching clients on a FULI Bot, build a compact cross-client Handoff Brief!
    let handoff_brief_preview = if mode == ConciergeDispatchMode::SwitchClientHandoff
        && let Some(ref ledger) = selected_ledger
    {
        Some(build_handoff_brief(
            store,
            &ledger.agent_id,
            &ledger.agent_name,
            switched_from_client.as_deref(),
            &target_client,
        )?)
    } else {
        None
    };

    let selected_agent_name = selected_ledger
        .as_ref()
        .map(|l| l.agent_name.clone())
        .unwrap_or_else(|| {
            if is_global_overview {
                "全局所有项目".to_string()
            } else {
                "未匹配具体项目".to_string()
            }
        });

    Ok(ConciergeRoutePreview {
        prompt,
        is_global_overview,
        selected_agent_id: selected_ledger.map(|l| l.agent_id),
        selected_agent_name,
        auto_detected,
        confidence,
        reason,
        candidate_bots: candidates,
        target_client,
        target_session_id,
        target_session_summary,
        working_dir,
        client_cli_available,
        allow_write: req.allow_write,
        switched_from_client,
        available_clients: SUPPORTED_CLIENTS.iter().map(|s| (*s).to_string()).collect(),
        mode,
        can_answer_from_memory,
        handoff_brief_preview,
    })
}

/// Record a human route correction ("this utterance belongs to Bot X") into local `settings`
/// so future auto-routing for those terms immediately learns from the user!
pub fn record_concierge_route_correction(
    store: &FuliStore,
    prompt: &str,
    correct_agent_id: &str,
) -> StoreResult<usize> {
    let mut hints = load_route_hints(store);
    let mut added = 0usize;
    for term in crate::substantive_terms(prompt).into_iter().take(4) {
        hints.insert(term, correct_agent_id.to_string());
        added += 1;
    }
    while hints.len() > 120 {
        if let Some(first_key) = hints.keys().next().cloned() {
            hints.remove(&first_key);
        } else {
            break;
        }
    }
    let serialized = serde_json::to_string(&hints)?;
    store.set_setting(ROUTE_HINTS_SETTING_KEY, &serialized)?;
    Ok(added)
}

/// Build an instant 0-token global portfolio & session status digest across all FULI Bots.
pub fn build_global_overview_answer(store: &FuliStore) -> StoreResult<String> {
    let ledgers = build_bot_session_ledgers(store)?;
    if ledgers.is_empty() {
        return Ok("当前还没有注册 FULI Bot，可以先在「项目」页添加一个项目。".to_string());
    }
    let mut lines = vec![format!(
        "[FULI 大管家 · 全局实况 · 0 Token] 当前共管理 {} 个 FULI Bot：",
        ledgers.len()
    )];
    for l in ledgers.iter().take(8) {
        let sess_part = match &l.latest_session {
            Some(s) => format!(
                "最近活跃：{} ({}) · {}",
                client_display_name(&s.client_id),
                short_session_id(&s.session_id),
                s.summary
            ),
            None => "暂无最近客户端会话".to_string(),
        };
        let ws_part = match (&l.active_workstream_title, &l.active_workstream_state) {
            (Some(title), Some(state)) => format!("｜工作线「{title}」：{state}"),
            (Some(title), None) => format!("｜进行中工作线「{title}」"),
            _ => String::new(),
        };
        lines.push(format!("- **{}**：{}{}", l.agent_name, sess_part, ws_part));
    }
    Ok(lines.join("\n"))
}

/// Build a compact cross-client Handoff Brief when switching a FULI Bot from Client A to Client B.
/// Never dumps raw chat history — carries only active hard rules, preferences, and latest checkpoint!
pub fn build_handoff_brief(
    store: &FuliStore,
    agent_id: &str,
    agent_name: &str,
    from_client: Option<&str>,
    to_client: &str,
) -> StoreResult<String> {
    let mut lines = vec![format!(
        "[FULI 跨客户端接力简报] 项目：{}｜从 {} 切换至 {}",
        agent_name,
        from_client.map(client_display_name).unwrap_or("历史记忆"),
        client_display_name(to_client)
    )];

    let open_ws = store.list_workstreams(Some(agent_id), true)?;
    if let Some(ws) = open_ws.first() {
        if let Some(cp) = store.latest_checkpoint_for_workstream(&ws.id)? {
            lines.push(format!("• 当前工作线：{}（目标：{}）", ws.title, cp.goal));
            if !cp.current_state.trim().is_empty() {
                lines.push(format!("• 最新进展：{}", cp.current_state));
            }
            if !cp.next_steps.is_empty() {
                lines.push(format!("• 下一步：{}", cp.next_steps.join("；")));
            }
        } else {
            lines.push(format!("• 当前工作线：{}", ws.title));
        }
    }

    let rules = store.resolve_effective_rules(Some(agent_id), None)?;
    if !rules.hard_rules.is_empty() {
        let top_rules: Vec<String> = rules
            .hard_rules
            .iter()
            .take(3)
            .map(|r| r.content.clone())
            .collect();
        lines.push(format!("• 生效红线：{}", top_rules.join("；")));
    }

    Ok(lines.join("\n"))
}

/// Prepare a Concierge dispatch against the 3-tier Roundtable engine (fast, <5ms under SQLite lock).
/// Returns either an immediate outcome (Tier 0 / global overview / Tier 2 inbox) or a lock-free
/// `AskAgentPlan::RunNativeWake` for background execution in the Bot's real `working_dir`!
pub fn prepare_concierge_dispatch(
    store: &FuliStore,
    vector_cache: Option<&IdleUnloadVectorCache>,
    preview: &ConciergeRoutePreview,
) -> StoreResult<ConciergeDispatchPrep> {
    if preview.is_global_overview && preview.mode == ConciergeDispatchMode::MemoryAnswer {
        let answer = build_global_overview_answer(store)?;
        let ex = store.insert_roundtable_exchange(
            None,
            "fuli-concierge",
            "concierge",
            "fuli-concierge",
            "overview",
            &preview.prompt,
            Some(&answer),
            WakeStatus::WokenReplied,
        )?;
        return Ok(ConciergeDispatchPrep::ImmediateOverview {
            exchange_id: ex.id,
            answer,
        });
    }

    let question = match &preview.handoff_brief_preview {
        Some(brief) if preview.mode == ConciergeDispatchMode::SwitchClientHandoff => {
            format!("{brief}\n\n[用户新指令]\n{}", preview.prompt)
        }
        _ => preview.prompt.clone(),
    };

    let (allow_memory_fast_path, attempt_native_wake, allow_fresh_session) = match preview.mode {
        ConciergeDispatchMode::MemoryAnswer => (true, false, false),
        ConciergeDispatchMode::ResumeLatestSession => (false, true, true),
        ConciergeDispatchMode::SwitchClientHandoff => (false, true, true),
        ConciergeDispatchMode::QueueClientInbox => (false, false, false),
    };

    let plan = prepare_ask_agent(
        store,
        vector_cache,
        &AskAgentInput {
            agent_id: preview.selected_agent_id.clone(),
            from_client: "fuli-concierge".into(),
            from_session_id: "concierge".into(),
            to_client: preview.target_client.clone(),
            to_session_id: preview.target_session_id.clone(),
            question,
            allow_memory_fast_path,
            attempt_native_wake,
            wake_timeout_ms: Some(30_000),
            cwd: preview.working_dir.clone(),
            allow_fresh_session,
            allow_write: preview.allow_write,
        },
    )?;

    Ok(ConciergeDispatchPrep::Roundtable(Box::new(plan)))
}

#[derive(Debug, Clone)]
pub enum ConciergeDispatchPrep {
    ImmediateOverview { exchange_id: String, answer: String },
    Roundtable(Box<AskAgentPlan>),
}

/// Build an initial `ConciergeTask` record right when a dispatch starts.
pub fn new_concierge_task(
    id: String,
    preview: &ConciergeRoutePreview,
    was_corrected: bool,
) -> ConciergeTask {
    let safety_tag = if preview.allow_write {
        "可写模式"
    } else {
        "只读安全"
    };
    let step_label = match preview.mode {
        ConciergeDispatchMode::MemoryAnswer => "正在检索 FULI Bot 记忆与进度...".to_string(),
        ConciergeDispatchMode::ResumeLatestSession => format!(
            "正在唤醒 {} 会话 ({}) · {safety_tag}...",
            client_display_name(&preview.target_client),
            short_session_id(&preview.target_session_id)
        ),
        ConciergeDispatchMode::SwitchClientHandoff => format!(
            "正在打包接力简报并启动 {} · {safety_tag}...",
            client_display_name(&preview.target_client)
        ),
        ConciergeDispatchMode::QueueClientInbox => format!(
            "正在投递到 {} 收件箱（下轮自动捎带）...",
            client_display_name(&preview.target_client)
        ),
    };

    ConciergeTask {
        id,
        prompt: preview.prompt.clone(),
        agent_id: preview.selected_agent_id.clone(),
        agent_name: preview.selected_agent_name.clone(),
        target_client: preview.target_client.clone(),
        target_session_id: preview.target_session_id.clone(),
        switched_from_client: preview.switched_from_client.clone(),
        mode: preview.mode,
        status: ConciergeTaskStatus::Running,
        step_label,
        result_preview: None,
        exchange_id: None,
        was_corrected,
        started_at: now_rfc3339(),
        finished_at: None,
        elapsed_ms: 0,
    }
}

// ============================================================================
// Internal Helpers (Deterministic, Local, <3ms)
// ============================================================================

fn resolve_bot_working_dir(
    store: &FuliStore,
    ledger: Option<&BotSessionLedger>,
    matched_sess: Option<&BotSessionDigest>,
) -> Option<String> {
    if let Some(s) = matched_sess
        && !s.cwd.trim().is_empty()
    {
        return Some(s.cwd.clone());
    }
    if let Some(l) = ledger {
        if let Some(s) = &l.latest_session
            && !s.cwd.trim().is_empty()
        {
            return Some(s.cwd.clone());
        }
        if let Ok(bindings) = store.list_agent_bindings(&l.agent_id)
            && let Some(dir_b) = bindings
                .into_iter()
                .find(|b| b.kind == BindingKind::DirPath)
        {
            return Some(dir_b.canonical_key);
        }
    }
    None
}

fn score_bot_candidates(
    store: &FuliStore,
    agents: &[FuliAgent],
    ledgers: &[BotSessionLedger],
    hints: &HashMap<String, String>,
    prompt: &str,
) -> StoreResult<Vec<BotRouteCandidate>> {
    let prompt_lower = prompt.to_lowercase();
    let prompt_terms = crate::substantive_terms(prompt);
    let ledger_map: HashMap<&str, &BotSessionLedger> =
        ledgers.iter().map(|l| (l.agent_id.as_str(), l)).collect();

    let mut out = Vec::with_capacity(agents.len());
    for (recency_rank, ledger) in ledgers.iter().enumerate() {
        let agent = agents.iter().find(|a| a.id == ledger.agent_id);
        let mut score = 0u32;
        let mut reasons: Vec<String> = Vec::new();

        let name_lower = ledger.agent_name.to_lowercase();
        if !name_lower.is_empty() && prompt_lower.contains(&name_lower) {
            score += 65;
            reasons.push(format!("提到项目「{}」", ledger.agent_name));
        }

        let bindings = store.list_agent_bindings(&ledger.agent_id)?;
        for b in &bindings {
            let base = short_dir_name(&b.canonical_key).to_lowercase();
            if base.len() >= 2 && prompt_lower.contains(&base) && base != name_lower {
                score += 50;
                reasons.push(format!("匹配仓库「{base}」"));
                break;
            }
        }

        for term in &prompt_terms {
            if hints.get(term).is_some_and(|aid| aid == &ledger.agent_id) {
                score += 45;
                reasons.push("记住你上次的纠偏选择".to_string());
                break;
            }
        }

        let desc = agent.map(|a| a.description.as_str()).unwrap_or("");
        let ws_title = ledger.active_workstream_title.as_deref().unwrap_or("");
        let meta_hay = format!("{desc} {ws_title}").to_lowercase();
        if !prompt_terms.is_empty() && !meta_hay.trim().is_empty() {
            let meta_tokens: Vec<String> = tokenize_query_terms(&meta_hay);
            let overlap = prompt_terms
                .iter()
                .filter(|t| meta_hay.contains(t.as_str()) || meta_tokens.contains(t))
                .count();
            if overlap > 0 {
                score += (overlap as u32 * 14).min(35);
                if !ws_title.is_empty() {
                    reasons.push(format!("贴合工作线「{ws_title}」"));
                }
            }
        }

        if ledger.latest_session.is_some() {
            let bonus = 16u32.saturating_sub((recency_rank as u32) * 3);
            score += bonus;
            if reasons.is_empty() {
                reasons.push("最近活跃的 FULI Bot".to_string());
            }
        } else if reasons.is_empty() {
            reasons.push("备选 FULI Bot".to_string());
        }

        let latest = ledger_map
            .get(ledger.agent_id.as_str())
            .and_then(|l| l.latest_session.as_ref());

        out.push(BotRouteCandidate {
            agent_id: ledger.agent_id.clone(),
            agent_name: ledger.agent_name.clone(),
            score,
            latest_client: latest.map(|s| s.client_id.clone()),
            latest_session_id: latest.map(|s| s.session_id.clone()),
            reason: reasons.join(" · "),
        });
    }

    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.agent_name.cmp(&b.agent_name))
    });
    Ok(out)
}

fn load_route_hints(store: &FuliStore) -> HashMap<String, String> {
    store
        .get_setting(ROUTE_HINTS_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default()
}

fn detect_client_mention(prompt: &str) -> Option<String> {
    let lower = prompt.to_lowercase();
    if lower.contains("claude-code") || lower.contains("claude code") || lower.contains("claude") {
        Some("claude-code".to_string())
    } else if lower.contains("codex") {
        Some("codex".to_string())
    } else if lower.contains("opencode") || lower.contains("open code") {
        Some("opencode".to_string())
    } else if lower.contains("cursor") {
        Some("cursor".to_string())
    } else {
        None
    }
}

/// Clients that can be woken from the command line, in fallback order.
const WAKEABLE_FALLBACK_ORDER: [&str; 3] = ["claude-code", "codex", "opencode"];

/// Choose the client to route to.
/// Returns `(client, Some(unavailable))` when an automatic choice was not installed and a
/// different installed client was picked instead.
fn pick_target_client(
    explicit: Option<String>,
    last_used: Option<String>,
    is_available: impl Fn(&str) -> bool,
) -> (String, Option<String>) {
    if let Some(client) = explicit {
        return (client, None);
    }
    let preferred = last_used.unwrap_or_else(|| WAKEABLE_FALLBACK_ORDER[0].to_string());
    // GUI-only clients (Cursor) are never "available" on the command line; keep them so
    // their inbox still works.
    if !WAKEABLE_FALLBACK_ORDER.contains(&preferred.as_str()) || is_available(&preferred) {
        return (preferred, None);
    }
    match WAKEABLE_FALLBACK_ORDER
        .iter()
        .find(|c| **c != preferred && is_available(c))
    {
        Some(installed) => ((*installed).to_string(), Some(preferred)),
        None => (preferred, None),
    }
}

#[cfg(test)]
mod pick_client_tests {
    use super::pick_target_client;

    #[test]
    fn automatic_choice_falls_back_to_an_installed_client() {
        let only_codex = |c: &str| c == "codex";
        // Nothing known about the project: default Claude Code is missing → Codex.
        assert_eq!(
            pick_target_client(None, None, only_codex),
            ("codex".to_string(), Some("claude-code".to_string()))
        );
        // Last used client missing → next installed one.
        assert_eq!(
            pick_target_client(None, Some("claude-code".into()), only_codex),
            ("codex".to_string(), Some("claude-code".to_string()))
        );
        // Last used client installed → kept.
        assert_eq!(
            pick_target_client(None, Some("codex".into()), only_codex),
            ("codex".to_string(), None)
        );
    }

    #[test]
    fn explicit_and_gui_choices_are_kept() {
        let nothing = |_: &str| false;
        // The user named it: keep it, the preview shows it is not installed.
        assert_eq!(
            pick_target_client(Some("claude-code".into()), None, nothing),
            ("claude-code".to_string(), None)
        );
        // Cursor has no command line; its inbox still works, so no fallback.
        assert_eq!(
            pick_target_client(None, Some("cursor".into()), |c| c == "codex"),
            ("cursor".to_string(), None)
        );
        // Nothing installed at all: keep the default instead of inventing one.
        assert_eq!(
            pick_target_client(None, None, nothing),
            ("claude-code".to_string(), None)
        );
    }
}

fn normalize_client_name(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => "claude-code".to_string(),
        "codex" => "codex".to_string(),
        "opencode" | "open-code" | "open_code" => "opencode".to_string(),
        "cursor" => "cursor".to_string(),
        other => other.to_string(),
    }
}

pub fn client_display_name(client: &str) -> &'static str {
    match client.to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => "Claude Code",
        "codex" => "Codex",
        "opencode" | "open-code" | "open_code" => "OpenCode",
        "cursor" => "Cursor",
        "fuli-concierge" => "FULI 大管家",
        _ => "AI 客户端",
    }
}

pub fn short_session_id(session_id: &str) -> String {
    let trimmed = session_id.trim();
    if trimmed.is_empty() || trimmed == "*" || trimmed == "default" {
        return "新会话".to_string();
    }
    if trimmed.chars().count() <= 12 {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(10).collect::<String>())
    }
}

fn short_dir_name(raw: &str) -> String {
    let clean = raw.trim().trim_end_matches(['/', '\\']);
    let without_git = clean.strip_suffix(".git").unwrap_or(clean);
    Path::new(without_git)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(without_git)
        .to_string()
}

fn looks_like_global_overview(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let triggers = [
        "所有项目",
        "全部项目",
        "全局进度",
        "最近都在干",
        "最近在干嘛",
        "各个项目",
        "所有 bot",
        "所有bot",
        "所有会话",
        "all projects",
        "all bots",
        "overview",
        "status of all",
    ];
    triggers.iter().any(|t| lower.contains(t))
}

fn looks_like_explicit_execution(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let verbs = [
        "改一下",
        "修改",
        "实现",
        "加上",
        "补个",
        "修一下",
        "修复",
        "重构",
        "运行",
        "测试",
        "提交",
        "继续",
        "切到",
        "切换",
        "implement",
        "fix ",
        "add ",
        "run ",
        "switch to",
        "continue",
    ];
    verbs.iter().any(|v| lower.contains(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{
        BindingRole, ConstraintClass, DecisionRecord, PreferenceAspect, RuleApplicability,
        RuleAuthority, RuleScope, RuleStatus,
    };
    use fuli_store::{CheckpointInput, UpsertRuleInput};

    #[test]
    fn concierge_auto_routes_by_project_switches_client_with_handoff_and_learns_corrections() {
        let store = FuliStore::open_in_memory().unwrap();
        let bot_fuli = store
            .create_agent("FULI", "Rust 桌面内核", "zh-CN", "")
            .unwrap();
        let bot_shop = store
            .create_agent("shop-web", "电商前端", "zh-CN", "")
            .unwrap();

        store
            .bind_agent(
                &bot_fuli.id,
                BindingKind::DirPath,
                "t:/workspace/fuli",
                BindingRole::Own,
                "next",
            )
            .unwrap();
        store
            .upsert_rule_or_pref(UpsertRuleInput {
                id: None,
                scope_kind: RuleScope::Agent,
                scope_id: bot_fuli.id.clone(),
                constraint_class: ConstraintClass::HardRule,
                aspect: PreferenceAspect::HardRule,
                pref_key: "mem.limit".into(),
                authority: RuleAuthority::HumanExplicit,
                status: RuleStatus::Active,
                content: "fuli-context 常驻内存必须 < 25 MiB".into(),
                rationale: "硬红线".into(),
                applicability: RuleApplicability::default(),
            })
            .unwrap();
        store
            .checkpoint_workstream(CheckpointInput {
                workstream_id: None,
                agent_id: bot_fuli.id.clone(),
                title: Some("圆桌三级路由".into()),
                status: None,
                worktree_path: Some("t:/workspace/fuli".into()),
                branch_name: Some("next".into()),
                goal: "完成大管家与三级路由".into(),
                current_state: "Tier 0 与 Hook 捎带已完成".into(),
                decisions: vec![DecisionRecord {
                    decision: "锁外唤醒外部 CLI".into(),
                    reason: "避免 IPC 死锁".into(),
                }],
                next_steps: vec!["联调大管家面板".into()],
                reused_refs: vec![],
                source_client: "claude-code".into(),
                source_session_id: "sess-cc-99".into(),
            })
            .unwrap();
        store
            .upsert_session(
                "claude-code",
                "sess-cc-99",
                Some(&bot_fuli.id),
                None,
                "t:/workspace/fuli",
                Some("圆桌三级路由调试"),
            )
            .unwrap();

        // 1. Auto-route by project name -> picks FULI + latest claude-code session `sess-cc-99` + cwd!
        let p1 = preview_concierge_route(
            &store,
            None,
            &ConciergePreviewRequest {
                prompt: "帮我继续把 FULI 的圆桌测试补完".into(),
                override_agent_id: None,
                override_client: None,
                override_session_id: None,
                override_mode: None,
                allow_write: false,
            },
        )
        .unwrap();
        assert_eq!(p1.selected_agent_id.as_deref(), Some(bot_fuli.id.as_str()));
        assert_eq!(p1.target_client, "claude-code");
        assert_eq!(p1.target_session_id, "sess-cc-99");
        assert_eq!(p1.working_dir.as_deref(), Some("t:/workspace/fuli"));
        assert_eq!(p1.mode, ConciergeDispatchMode::ResumeLatestSession);
        assert!(p1.switched_from_client.is_none());

        // 2. Switch client to Codex on the SAME Bot -> builds Handoff Brief + prepares fresh Codex launch!
        let p2 = preview_concierge_route(
            &store,
            None,
            &ConciergePreviewRequest {
                prompt: "切到 Codex 继续做 FULI 的圆桌联调".into(),
                override_agent_id: None,
                override_client: None,
                override_session_id: None,
                override_mode: None,
                allow_write: true,
            },
        )
        .unwrap();
        assert_eq!(p2.selected_agent_id.as_deref(), Some(bot_fuli.id.as_str()));
        assert_eq!(p2.target_client, "codex");
        assert_eq!(p2.switched_from_client.as_deref(), Some("claude-code"));
        assert_eq!(p2.mode, ConciergeDispatchMode::SwitchClientHandoff);
        assert!(p2.allow_write);
        let brief = p2.handoff_brief_preview.as_deref().unwrap();
        assert!(brief.contains("Tier 0 与 Hook 捎带已完成"));
        assert!(brief.contains("< 25 MiB"));

        // 3. Global overview query -> 0-token multi-bot overview + persists across restarts!
        let p3 = preview_concierge_route(
            &store,
            None,
            &ConciergePreviewRequest {
                prompt: "看看所有项目最近都在干嘛".into(),
                override_agent_id: None,
                override_client: None,
                override_session_id: None,
                override_mode: None,
                allow_write: false,
            },
        )
        .unwrap();
        assert!(p3.is_global_overview);
        assert_eq!(p3.mode, ConciergeDispatchMode::MemoryAnswer);
        let _ = prepare_concierge_dispatch(&store, None, &p3).unwrap();
        let hydrated = hydrate_persisted_concierge_tasks(&store, &[], 10).unwrap();
        assert_eq!(hydrated.len(), 1);
        assert!(
            hydrated[0]
                .result_preview
                .as_deref()
                .unwrap()
                .contains("FULI")
        );

        // 4. User corrects a route -> future query for those terms routes to corrected Bot!
        let added =
            record_concierge_route_correction(&store, "把结账页面的优惠券弹窗修一下", &bot_shop.id)
                .unwrap();
        assert!(added > 0);
        let p4 = preview_concierge_route(
            &store,
            None,
            &ConciergePreviewRequest {
                prompt: "结账页面的优惠券样式再调一下".into(),
                override_agent_id: None,
                override_client: None,
                override_session_id: None,
                override_mode: None,
                allow_write: false,
            },
        )
        .unwrap();
        assert_eq!(p4.selected_agent_id.as_deref(), Some(bot_shop.id.as_str()));
    }
}
