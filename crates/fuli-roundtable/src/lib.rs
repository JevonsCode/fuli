//! FULI 3-Tier Cross-Model / Cross-Client Roundtable Router (`fuli-roundtable`).
//!
//! Optimal pure-local routing for heterogeneous clients (CLI + GUI IDE) & models:
//! - **Tier 0 (`MemoryFastPath`)**: <5ms, 0 LLM tokens — checks target FULI Bot's latest open
//!   workstream checkpoints and 2-hop authorized confirmed KB before disturbing any live session.
//! - **Tier 1 (`NativeCliWake`)**: live read-only headless wake for supported CLI clients
//!   (`claude --resume --fork-session -p`, `codex exec resume --sandbox read-only`,
//!   `opencode run --session`) with strict bounded timeout so IPC never stalls.
//! - **Tier 2 (`QueuedInbox`)**: honest fallback into local SQLite inbox, automatically piggybacked
//!   onto the target client's next `UserPromptSubmit` Hook or `resolve_context` MCP turn
//!   (works seamlessly across Cursor, Antigravity, Claude Desktop, and offline CLI sessions).

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use fuli_domain::{KbItemStatus, RoundtableExchange, WakeStatus};
use fuli_search::{IdleUnloadVectorCache, SearchOptions, search_knowledge_with_cache};
use fuli_store::{FuliStore, StoreResult, tokenize_query_terms};
use serde::{Deserialize, Serialize};

pub mod concierge;
pub use concierge::*;

const DEFAULT_WAKE_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoundtableTier {
    /// Tier 0: Answered directly in <5ms / 0 LLM tokens from target Bot's checkpoint or confirmed KB.
    MemoryFastPath,
    /// Tier 1: Live read-only headless wake of target CLI session (Claude Code / Codex / OpenCode).
    NativeCliWake,
    /// Tier 2: Queued cleanly in local inbox; piggybacked on target's next Hook / MCP turn.
    QueuedInbox,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeWakeCommand {
    pub program: String,
    pub args: Vec<String>,
    pub display_cli: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySourceRef {
    pub kind: String,
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskAgentInput {
    pub agent_id: Option<String>,
    pub from_client: String,
    pub from_session_id: String,
    pub to_client: String,
    pub to_session_id: String,
    pub question: String,
    /// When true (default), attempts Tier-0 0-token memory fast-path before waking or queuing.
    #[serde(default = "default_true")]
    pub allow_memory_fast_path: bool,
    /// When true, attempts Tier-1 read-only local CLI resume if Tier-0 does not answer.
    /// Falls back honestly to `QueuedInbox` on unsupported GUI client, error, or timeout.
    #[serde(default)]
    pub attempt_native_wake: bool,
    /// Optional bounded timeout (ms) for Tier-1 CLI execution (default 15,000 ms).
    #[serde(default)]
    pub wake_timeout_ms: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskAgentOutcome {
    pub exchange: RoundtableExchange,
    pub tier: RoundtableTier,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<MemorySourceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_wake_cli: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

/// Lock-free execution plan produced by `prepare_ask_agent` so `fuli-context` can release
/// its SQLite mutex and IPC accept loop before spawning any external Tier-1 CLI process.
#[derive(Debug, Clone)]
pub enum AskAgentPlan {
    /// Already resolved in <5ms (Tier 0 memory fast-path, or Tier 2 direct inbox queue).
    Immediate(AskAgentOutcome),
    /// Requires spawning an external read-only CLI session outside any DB lock.
    RunNativeWake(PendingNativeWake),
}

#[derive(Debug, Clone)]
pub struct PendingNativeWake {
    pub resolved_agent_id: Option<String>,
    pub input: AskAgentInput,
    pub wake_cmd: NativeWakeCommand,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct NativeWakeExecution {
    pub answer: Option<String>,
    pub fallback_reason: Option<String>,
}

/// Build the exact read-only native wake command for supported CLI coding clients.
/// Uses the client's real `session_id` without LAN discovery or heavyweight brokers.
pub fn build_native_wake_command(
    to_client: &str,
    to_session_id: &str,
    question: &str,
) -> Option<NativeWakeCommand> {
    let trimmed_sess = to_session_id.trim();
    if trimmed_sess.is_empty() || trimmed_sess == "*" || trimmed_sess == "default" {
        return None;
    }
    let prompt = format!(
        "[FULI 圆桌只读问询] 请仅基于你当前会话上下文简明回答以下问题，严禁修改文件或执行写操作：\n{question}"
    );
    match to_client.to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => {
            let args = vec![
                "--resume".to_string(),
                trimmed_sess.to_string(),
                "--fork-session".to_string(),
                "-p".to_string(),
                prompt,
            ];
            Some(NativeWakeCommand {
                program: "claude".into(),
                display_cli: format!("claude --resume {trimmed_sess} --fork-session -p \"...\""),
                args,
            })
        }
        "codex" => {
            let args = vec![
                "exec".to_string(),
                "resume".to_string(),
                trimmed_sess.to_string(),
                "--sandbox".to_string(),
                "read-only".to_string(),
                prompt,
            ];
            Some(NativeWakeCommand {
                program: "codex".into(),
                display_cli: format!(
                    "codex exec resume {trimmed_sess} --sandbox read-only \"...\""
                ),
                args,
            })
        }
        "opencode" | "open-code" | "open_code" => {
            let args = vec![
                "run".to_string(),
                "--session".to_string(),
                trimmed_sess.to_string(),
                prompt,
            ];
            Some(NativeWakeCommand {
                program: "opencode".into(),
                display_cli: format!("opencode run --session {trimmed_sess} \"...\""),
                args,
            })
        }
        _ => None,
    }
}

/// Phase 1 (fast, under SQLite lock, <5ms):
/// Resolves Tier-0 memory fast-path or queues Tier-2 immediately when native wake is disabled/unsupported.
/// Returns `AskAgentPlan::RunNativeWake` ONLY when a bounded external CLI wake should run lock-free.
pub fn prepare_ask_agent(
    store: &FuliStore,
    vector_cache: Option<&IdleUnloadVectorCache>,
    input: &AskAgentInput,
) -> StoreResult<AskAgentPlan> {
    // Resolve target FULI Bot ID from explicit input OR target session metadata
    let resolved_agent_id = match input.agent_id.clone() {
        Some(aid) if !aid.trim().is_empty() => Some(aid),
        _ => store
            .get_session(&input.to_client, &input.to_session_id)?
            .and_then(|s| s.agent_id),
    };

    // -------------------------------------------------------------------------
    // Tier 0: 0-Token Memory Fast-Path (<5ms, zero external model calls)
    // -------------------------------------------------------------------------
    if input.allow_memory_fast_path
        && let Some((answer_text, sources)) = try_memory_fast_path(
            store,
            vector_cache,
            resolved_agent_id.as_deref(),
            &input.question,
        )?
    {
        let exchange = store.insert_roundtable_exchange(
            resolved_agent_id.as_deref(),
            &input.from_client,
            &input.from_session_id,
            &input.to_client,
            &input.to_session_id,
            &input.question,
            Some(&answer_text),
            WakeStatus::WokenReplied,
        )?;
        // Record compounding reuse so Today's ledger reflects saved cross-bot calls!
        if let Some(ref aid) = resolved_agent_id
            && let Some(first_src) = sources.first()
        {
            let _ = store.record_compounding_event(
                aid,
                if first_src.kind == "workstream_checkpoint" {
                    Some(first_src.id.as_str())
                } else {
                    None
                },
                &first_src.kind,
                &first_src.id,
                1,
                &input.from_client,
                &format!("圆桌第 0 级记忆直答（0 Token）：{}", first_src.title),
            );
        }
        return Ok(AskAgentPlan::Immediate(AskAgentOutcome {
            exchange,
            tier: RoundtableTier::MemoryFastPath,
            sources,
            native_wake_cli: None,
            fallback_reason: None,
        }));
    }

    // -------------------------------------------------------------------------
    // Tier 1 check: if enabled AND target CLI + session_id support native wake,
    // hand off to lock-free execution!
    // -------------------------------------------------------------------------
    let wake_cmd =
        build_native_wake_command(&input.to_client, &input.to_session_id, &input.question);
    let native_wake_cli = wake_cmd.as_ref().map(|c| c.display_cli.clone());

    if input.attempt_native_wake {
        if let Some(cmd) = wake_cmd {
            let timeout = Duration::from_millis(
                input
                    .wake_timeout_ms
                    .unwrap_or(DEFAULT_WAKE_TIMEOUT_MS)
                    .clamp(500, 120_000),
            );
            return Ok(AskAgentPlan::RunNativeWake(PendingNativeWake {
                resolved_agent_id,
                input: input.clone(),
                wake_cmd: cmd,
                timeout,
            }));
        }
        let exchange = store.insert_roundtable_exchange(
            resolved_agent_id.as_deref(),
            &input.from_client,
            &input.from_session_id,
            &input.to_client,
            &input.to_session_id,
            &input.question,
            None,
            WakeStatus::QueuedInbox,
        )?;
        return Ok(AskAgentPlan::Immediate(AskAgentOutcome {
            exchange,
            tier: RoundtableTier::QueuedInbox,
            sources: Vec::new(),
            native_wake_cli,
            fallback_reason: Some("client_or_session_requires_inbox".into()),
        }));
    }

    // -------------------------------------------------------------------------
    // Tier 2: Direct Honest Local Inbox Queue
    // -------------------------------------------------------------------------
    let exchange = store.insert_roundtable_exchange(
        resolved_agent_id.as_deref(),
        &input.from_client,
        &input.from_session_id,
        &input.to_client,
        &input.to_session_id,
        &input.question,
        None,
        WakeStatus::QueuedInbox,
    )?;

    Ok(AskAgentPlan::Immediate(AskAgentOutcome {
        exchange,
        tier: RoundtableTier::QueuedInbox,
        sources: Vec::new(),
        native_wake_cli,
        fallback_reason: None,
    }))
}

/// Phase 2 (completely lock-free, safe to run on a worker thread without holding SQLite mutex):
/// Spawns the bounded read-only CLI wake process and collects stdout or honest fallback reason.
pub fn execute_native_wake(pending: &PendingNativeWake) -> NativeWakeExecution {
    match run_command_with_timeout(
        &pending.wake_cmd.program,
        &pending.wake_cmd.args,
        pending.timeout,
    ) {
        Ok(text) if !text.trim().is_empty() => NativeWakeExecution {
            answer: Some(text.trim().to_string()),
            fallback_reason: None,
        },
        Ok(_) => NativeWakeExecution {
            answer: None,
            fallback_reason: Some("native_cli_empty_output".into()),
        },
        Err(reason) => NativeWakeExecution {
            answer: None,
            fallback_reason: Some(reason),
        },
    }
}

/// Phase 3 (fast, under SQLite lock, <1ms):
/// Persists the Tier-1 wake answer (or honest Tier-2 fallback) into `roundtable_exchanges`.
pub fn finalize_native_wake(
    store: &FuliStore,
    pending: PendingNativeWake,
    exec: NativeWakeExecution,
) -> StoreResult<AskAgentOutcome> {
    let (wake_status, tier) = if exec.answer.is_some() {
        (WakeStatus::WokenReplied, RoundtableTier::NativeCliWake)
    } else {
        (WakeStatus::QueuedInbox, RoundtableTier::QueuedInbox)
    };
    let exchange = store.insert_roundtable_exchange(
        pending.resolved_agent_id.as_deref(),
        &pending.input.from_client,
        &pending.input.from_session_id,
        &pending.input.to_client,
        &pending.input.to_session_id,
        &pending.input.question,
        exec.answer.as_deref(),
        wake_status,
    )?;
    Ok(AskAgentOutcome {
        exchange,
        tier,
        sources: Vec::new(),
        native_wake_cli: Some(pending.wake_cmd.display_cli),
        fallback_reason: exec.fallback_reason,
    })
}

/// Ask another FULI Bot / client session using the full 3-tier router:
/// Tier 0 (0-token memory fast-path) -> Tier 1 (bounded read-only CLI wake) -> Tier 2 (local inbox).
pub fn ask_agent_routed(
    store: &FuliStore,
    vector_cache: Option<&IdleUnloadVectorCache>,
    input: &AskAgentInput,
) -> StoreResult<AskAgentOutcome> {
    match prepare_ask_agent(store, vector_cache, input)? {
        AskAgentPlan::Immediate(outcome) => Ok(outcome),
        AskAgentPlan::RunNativeWake(pending) => {
            let exec = execute_native_wake(&pending);
            finalize_native_wake(store, pending, exec)
        }
    }
}

/// Backward-compatible entry point returning `RoundtableExchange` directly.
pub fn ask_agent(store: &FuliStore, input: &AskAgentInput) -> StoreResult<RoundtableExchange> {
    Ok(ask_agent_routed(store, None, input)?.exchange)
}

pub fn check_inbox(
    store: &FuliStore,
    client: Option<&str>,
    session_id: Option<&str>,
    only_pending: bool,
) -> StoreResult<Vec<RoundtableExchange>> {
    store.list_roundtable_exchanges(client, session_id, only_pending, 20)
}

/// Check pending inbox matching exact session OR client/bot wildcards (`*` / `default`).
pub fn check_inbox_for_turn(
    store: &FuliStore,
    client: &str,
    session_id: &str,
    agent_id: Option<&str>,
    limit: usize,
) -> StoreResult<Vec<RoundtableExchange>> {
    store.list_pending_roundtable_for_turn(client, session_id, agent_id, limit)
}

pub fn reply_inbox(store: &FuliStore, exchange_id: &str, answer: &str) -> StoreResult<()> {
    store.answer_roundtable_exchange(exchange_id, answer, WakeStatus::WokenReplied)
}

// ============================================================================
// Tier 0: 0-Token Memory Fast-Path Implementation
// ============================================================================

fn try_memory_fast_path(
    store: &FuliStore,
    vector_cache: Option<&IdleUnloadVectorCache>,
    agent_id: Option<&str>,
    question: &str,
) -> StoreResult<Option<(String, Vec<MemorySourceRef>)>> {
    let q_terms = substantive_terms(question);
    if q_terms.is_empty() {
        return Ok(None);
    }

    let mut sections: Vec<String> = Vec::new();
    let mut sources: Vec<MemorySourceRef> = Vec::new();

    // Source A: Target Bot's active workstream checkpoints (freshest live progress!)
    if let Some(aid) = agent_id {
        let open_ws = store.list_workstreams(Some(aid), true)?;
        let mut best_cp: Option<(usize, String, String, String)> = None;
        for ws in open_ws.into_iter().take(5) {
            if let Some(cp) = store.latest_checkpoint_for_workstream(&ws.id)? {
                let decisions_text = cp
                    .decisions
                    .iter()
                    .map(|d| format!("{}({})", d.decision, d.reason))
                    .collect::<Vec<_>>()
                    .join("; ");
                let next_text = cp.next_steps.join("; ");
                let haystack = format!(
                    "{} {} {} {} {}",
                    ws.title, cp.goal, cp.current_state, decisions_text, next_text
                );
                let hits = count_term_overlap(&q_terms, &haystack);
                if meets_fast_path_gate(hits, q_terms.len()) {
                    let excerpt = format!(
                        "- [工作线 Checkpoint · {}] 目标：{}；当前进展：{}{}{}",
                        ws.title,
                        cp.goal,
                        cp.current_state,
                        if decisions_text.is_empty() {
                            String::new()
                        } else {
                            format!("；已定决策：{decisions_text}")
                        },
                        if next_text.is_empty() {
                            String::new()
                        } else {
                            format!("；下一步：{next_text}")
                        }
                    );
                    if best_cp.as_ref().is_none_or(|b| hits > b.0) {
                        best_cp = Some((hits, ws.id, ws.title, excerpt));
                    }
                }
            }
        }
        if let Some((_, ws_id, ws_title, excerpt)) = best_cp {
            sections.push(excerpt);
            sources.push(MemorySourceRef {
                kind: "workstream_checkpoint".into(),
                id: ws_id,
                title: ws_title,
            });
        }
    }

    // Source B: 2-hop authorized confirmed KB search (strictly zero proposals / zero stale)
    let search_resp = search_knowledge_with_cache(
        store,
        &SearchOptions {
            query: question.to_string(),
            queries: Vec::new(),
            agent_id: agent_id.map(ToOwned::to_owned),
            kb_id: None,
            item_types: Vec::new(),
            limit: Some(3),
            byte_budget: Some(1200),
            include_proposals: false,
            query_vector: None,
        },
        None,
        vector_cache,
    )?;

    for hit in search_resp
        .hits
        .into_iter()
        .filter(|h| h.status == KbItemStatus::Confirmed && !h.needs_review)
    {
        let haystack = format!("{} {} {}", hit.title, hit.context_summary, hit.body);
        let overlap = count_term_overlap(&q_terms, &haystack);
        if hit.score >= 0.55 && meets_fast_path_gate(overlap, q_terms.len()) {
            let body_snippet: String = hit.body.chars().take(240).collect();
            sections.push(format!(
                "- [已确认知识 · {}] {}：{}",
                hit.kb_name, hit.title, body_snippet
            ));
            sources.push(MemorySourceRef {
                kind: "kb_item".into(),
                id: hit.id,
                title: hit.title,
            });
            if sections.len() >= 2 {
                break;
            }
        }
    }

    if sections.is_empty() {
        return Ok(None);
    }

    let answer = format!(
        "[FULI 记忆直答 · 0 Token · 未打扰目标会话]\n{}",
        sections.join("\n")
    );
    Ok(Some((answer, sources)))
}

fn substantive_terms(text: &str) -> Vec<String> {
    let stop: HashSet<&str> = [
        "吗",
        "呢",
        "的",
        "了",
        "是",
        "在",
        "有",
        "和",
        "我",
        "你",
        "他",
        "她",
        "它",
        "这",
        "那",
        "什么",
        "怎么",
        "请问",
        "一下",
        "刚才",
        "那边",
        "已经",
        "有没有",
        "是否",
        "the",
        "is",
        "are",
        "was",
        "were",
        "what",
        "how",
        "did",
        "does",
        "have",
        "has",
        "for",
        "with",
        "about",
    ]
    .into_iter()
    .collect();

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for term in tokenize_query_terms(text) {
        let lower = term.to_lowercase();
        if lower.chars().count() < 2 || stop.contains(lower.as_str()) {
            continue;
        }
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    out
}

fn count_term_overlap(query_terms: &[String], haystack: &str) -> usize {
    let hay_lower = haystack.to_lowercase();
    let hay_tokens: HashSet<String> = tokenize_query_terms(&hay_lower).into_iter().collect();
    query_terms
        .iter()
        .filter(|qt| hay_tokens.contains(qt.as_str()) || hay_lower.contains(qt.as_str()))
        .count()
}

fn meets_fast_path_gate(matched: usize, total: usize) -> bool {
    if total == 0 {
        return false;
    }
    if total <= 2 {
        matched >= 1
    } else {
        matched >= 2
    }
}

/// Spawn external CLI command with a strict bounded timeout and concurrent pipe draining
/// so large stdout/stderr bursts never deadlock and `fuli-context` IPC never hangs.
fn run_command_with_timeout(
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .env("FULI_ROUNDTABLE_WAKE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn_failed:{e}"))?;

    let stdout_handle = child.stdout.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = stdout_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                if status.success() {
                    return Ok(out);
                }
                let err = stderr_handle
                    .and_then(|h| h.join().ok())
                    .unwrap_or_default();
                return Err(format!(
                    "exit_{}:{}",
                    status.code().unwrap_or(-1),
                    err.trim().chars().take(120).collect::<String>()
                ));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    if let Some(h) = stdout_handle {
                        let _ = h.join();
                    }
                    if let Some(h) = stderr_handle {
                        let _ = h.join();
                    }
                    return Err("wake_timeout".into());
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wait_failed:{e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{DecisionRecord, KbItemType};
    use fuli_store::{CheckpointInput, UpsertKbItemInput};

    #[test]
    fn builds_native_resume_commands_for_claude_code_codex_and_opencode() {
        let claude = build_native_wake_command("claude-code", "sess-c1", "刚才为什么改了端口？")
            .expect("claude cmd");
        assert_eq!(claude.program, "claude");
        assert!(claude.args.contains(&"--resume".to_string()));
        assert!(claude.args.contains(&"--fork-session".to_string()));
        assert!(claude.args.contains(&"sess-c1".to_string()));

        let codex =
            build_native_wake_command("codex", "sess-x2", "单测通过了吗？").expect("codex cmd");
        assert_eq!(codex.program, "codex");
        assert!(codex.args.contains(&"--sandbox".to_string()));
        assert!(codex.args.contains(&"read-only".to_string()));
        assert!(codex.args.contains(&"sess-x2".to_string()));

        let opencode = build_native_wake_command("opencode", "sess-oc3", "构建成功了吗？")
            .expect("opencode cmd");
        assert_eq!(opencode.program, "opencode");
        assert!(opencode.args.contains(&"run".to_string()));
        assert!(opencode.args.contains(&"--session".to_string()));
        assert!(opencode.args.contains(&"sess-oc3".to_string()));

        // GUI clients & wildcard sessions return None cleanly -> Tier 2 inbox
        assert!(build_native_wake_command("cursor", "s1", "hi").is_none());
        assert!(build_native_wake_command("claude-code", "*", "hi").is_none());
    }

    #[test]
    fn tier0_memory_fast_path_answers_from_checkpoint_and_confirmed_kb_with_zero_tokens() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("FULI", "Rust v2", "zh-CN", "").unwrap();
        let kb = store.primary_kb_for_agent(&agent.id).unwrap().unwrap();

        // Seed confirmed KB + active workstream checkpoint
        store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb.id.clone(),
                stable_key: Some("schema-tables".into()),
                item_type: KbItemType::Decision,
                status: KbItemStatus::Confirmed,
                lang: "zh-CN".into(),
                translation_of_id: None,
                title: "SQLite WAL 18 表结构已冻结".into(),
                body: "SQLite 单文件 fuli.db 包含 18 张表，已通过全量回归。".into(),
                context_summary: "数据库 schema".into(),
                aliases: vec!["schema".into(), "表结构".into()],
                evidence: serde_json::json!({}),
                change_reason: "test".into(),
                changed_by: "codex".into(),
            })
            .unwrap();

        store
            .checkpoint_workstream(CheckpointInput {
                workstream_id: None,
                agent_id: agent.id.clone(),
                title: Some("M2 数据库与圆桌联调".into()),
                status: None,
                worktree_path: Some("t:/workspace/fuli".into()),
                branch_name: Some("next".into()),
                goal: "验证 SQLite schema 与圆桌三级路由".into(),
                current_state: "18 张表全部就绪，34 条测试全绿".into(),
                decisions: vec![DecisionRecord {
                    decision: "保持单一 fuli.db WAL".into(),
                    reason: "常驻内存 < 25 MiB".into(),
                }],
                next_steps: vec!["接通 Hook 顺手捎带未读信箱".into()],
                reused_refs: vec![],
                source_client: "claude-code".into(),
                source_session_id: "sess-claude-1".into(),
            })
            .unwrap();

        store
            .upsert_session(
                "claude-code",
                "sess-claude-1",
                Some(&agent.id),
                None,
                "t:/workspace/fuli",
                None,
            )
            .unwrap();

        // Ask without explicit agent_id -> resolves via target session & answers in Tier 0!
        let outcome = ask_agent_routed(
            &store,
            None,
            &AskAgentInput {
                agent_id: None,
                from_client: "codex".into(),
                from_session_id: "sess-codex-1".into(),
                to_client: "claude-code".into(),
                to_session_id: "sess-claude-1".into(),
                question: "SQLite schema 表结构确认完了吗？".into(),
                allow_memory_fast_path: true,
                attempt_native_wake: false,
                wake_timeout_ms: None,
            },
        )
        .unwrap();

        assert_eq!(outcome.tier, RoundtableTier::MemoryFastPath);
        assert_eq!(outcome.exchange.wake_status, WakeStatus::WokenReplied);
        assert!(!outcome.sources.is_empty());
        let ans = outcome.exchange.answer.as_deref().unwrap();
        assert!(ans.contains("0 Token"));
        assert!(ans.contains("18"));

        // Unrelated question skips Tier 0 cleanly -> lands in Tier 2 QueuedInbox!
        let miss = ask_agent_routed(
            &store,
            None,
            &AskAgentInput {
                agent_id: Some(agent.id.clone()),
                from_client: "codex".into(),
                from_session_id: "sess-codex-1".into(),
                to_client: "cursor".into(),
                to_session_id: "sess-cursor-1".into(),
                question: "明天中午去吃拉面还是火锅？".into(),
                allow_memory_fast_path: true,
                attempt_native_wake: false,
                wake_timeout_ms: None,
            },
        )
        .unwrap();
        assert_eq!(miss.tier, RoundtableTier::QueuedInbox);
        assert_eq!(miss.exchange.wake_status, WakeStatus::QueuedInbox);
    }

    #[test]
    fn queues_to_inbox_and_supports_reply_roundtrip() {
        let store = FuliStore::open_in_memory().unwrap();
        let ex = ask_agent(
            &store,
            &AskAgentInput {
                agent_id: None,
                from_client: "codex".into(),
                from_session_id: "sess-a".into(),
                to_client: "claude-code".into(),
                to_session_id: "sess-b".into(),
                question: "你那边 SQLite schema 确认完字段了吗？".into(),
                allow_memory_fast_path: false,
                attempt_native_wake: false,
                wake_timeout_ms: None,
            },
        )
        .unwrap();
        assert_eq!(ex.wake_status, WakeStatus::QueuedInbox);

        let inbox = check_inbox(&store, Some("claude-code"), Some("sess-b"), true).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].id, ex.id);

        reply_inbox(&store, &ex.id, "确认完了，18 张表全部就绪。").unwrap();
        let pending = check_inbox(&store, Some("claude-code"), Some("sess-b"), true).unwrap();
        assert!(pending.is_empty());
        let all = check_inbox(&store, Some("claude-code"), Some("sess-b"), false).unwrap();
        assert_eq!(
            all[0].answer.as_deref(),
            Some("确认完了，18 张表全部就绪。")
        );
    }

    #[test]
    fn command_timeout_and_missing_binary_fallback_honestly_to_tier2_inbox() {
        // Nonexistent binary -> clean spawn_failed error
        let missing = run_command_with_timeout(
            "fuli-nonexistent-cli-binary-xyz",
            &["--version".into()],
            Duration::from_millis(500),
        );
        assert!(missing.is_err());
        assert!(missing.unwrap_err().starts_with("spawn_failed:"));

        // Cross-platform bounded timeout check
        #[cfg(windows)]
        let slow = run_command_with_timeout(
            "powershell",
            &[
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 5".into(),
            ],
            Duration::from_millis(250),
        );
        #[cfg(not(windows))]
        let slow = run_command_with_timeout("sleep", &["5".into()], Duration::from_millis(250));

        assert_eq!(slow, Err("wake_timeout".to_string()));
    }
}
