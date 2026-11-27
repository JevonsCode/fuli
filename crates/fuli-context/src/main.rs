#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dispatch;
mod memory;
mod server;
mod tray;
mod ui_process;

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use fuli_ipc::resolve_ipc_name;
use fuli_store::FuliStore;
use server::{DaemonState, run_ipc_loop};
use ui_process::UiProcessManager;

struct Config {
    headless: bool,
    ipc_endpoint: String,
    data_dir: Option<PathBuf>,
    ui_bin: Option<PathBuf>,
    ui_grace_secs: u64,
}

fn parse_args() -> Config {
    let mut headless = false;
    let mut ipc_name = None;
    let mut data_dir = None;
    let mut ui_bin = None;
    let mut ui_grace_secs = 30u64;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--headless" | "--no-tray" => headless = true,
            "--ipc-name" => ipc_name = args.next(),
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--ui-bin" => ui_bin = args.next().map(PathBuf::from),
            "--ui-grace-secs" => {
                if let Some(raw) = args.next()
                    && let Ok(parsed) = raw.parse::<u64>()
                {
                    ui_grace_secs = parsed;
                }
            }
            _ => {}
        }
    }

    Config {
        headless,
        ipc_endpoint: resolve_ipc_name(ipc_name.as_deref()),
        data_dir,
        ui_bin,
        ui_grace_secs,
    }
}

fn main() {
    let cfg = parse_args();
    let db_path = cfg
        .data_dir
        .map(|d| d.join("fuli.db"))
        .unwrap_or_else(FuliStore::default_db_path);

    let store = match FuliStore::open_path(&db_path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("fuli-context failed to open {}: {err}", db_path.display());
            std::process::exit(1);
        }
    };

    let ui = UiProcessManager::new(cfg.ui_bin, cfg.ipc_endpoint.clone(), cfg.ui_grace_secs);
    let state = Arc::new(DaemonState::new(
        cfg.ipc_endpoint.clone(),
        ui,
        store,
        Box::new(|| {}),
    ));
    let _maint_thread = state.spawn_background_maintenance();

    if cfg.headless {
        if let Err(err) = run_ipc_loop(Arc::clone(&state)) {
            eprintln!("fuli-context IPC exited with error: {err}");
            std::process::exit(1);
        }
        return;
    }

    let ipc_state = Arc::clone(&state);
    let ipc_thread = thread::spawn(move || {
        if let Err(err) = run_ipc_loop(ipc_state) {
            eprintln!("fuli-context IPC error: {err}");
        }
    });

    if let Err(err) = tray::run_tray_loop(Arc::clone(&state)) {
        eprintln!("fuli-context tray unavailable ({err}); continuing headless");
    }

    state.request_shutdown();
    let _ = ipc_thread.join();
}

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use fuli_domain::{KbLinkType, LinkAuthority};
    use fuli_ipc::{IpcRequest, IpcResponse, send_request};
    use serde_json::json;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn unique_ep(tag: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("fuli-e2e-{tag}-{}-{nanos}", std::process::id())
    }

    /// Golden Cross-Client E2E Test:
    /// Client A (Codex) registers FLA + sets hard rule + confirms 1-hop English runbook + checkpoints workstream
    /// -> Client B (Claude Code) runs Hook Turn 1 (auto-resolves FLA, injects hard rule, lists open workstream title ONLY)
    /// -> Client B runs Hook Turn 2 (ZERO duplicate rule injection!)
    /// -> Client B calls `resume_workstream` (gets exact goal/decisions/next_steps, no raw chat)
    /// -> Client B calls `search_knowledge` (hits 1-hop authorized English runbook via Chinese query, 0 unauthorized leaks)
    /// -> Client B calls `query_portfolio_summary` (gets real weekly compounding report)
    /// -> Client B calls `ask_agent` -> Client A calls `check_inbox` (roundtable handoff works!)
    #[test]
    fn golden_cross_client_compounding_loop_over_real_local_ipc() {
        let ep = unique_ep("golden");
        let store = FuliStore::open_in_memory().unwrap();

        // Pre-create one authorized 1-hop KB and one UNAUTHORIZED secret KB
        let kb_shared = store
            .create_kb("发布规范库", "团队发版手册", "en-US", false)
            .unwrap();
        let kb_secret = store
            .create_kb("绝密隔离库", "不可越权访问", "zh-CN", false)
            .unwrap();

        let ui = UiProcessManager::new(None, ep.clone(), 0);
        let state = Arc::new(DaemonState::new(ep.clone(), ui, store, Box::new(|| {})));

        let srv_state = Arc::clone(&state);
        let server_thread = thread::spawn(move || {
            let _ = run_ipc_loop(srv_state);
        });
        thread::sleep(Duration::from_millis(60));

        // 1. Client A (Codex) registers FULI Agent bound to a local workspace path
        let reg = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "register_agent".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({
                    "name": "FULI Core",
                    "description": "Rust 重写",
                    "dirPath": "t:/demo/fuli-core",
                    "gitRemote": "git@github.com:JevonsCode/fuli.git"
                }),
            },
        )
        .unwrap();
        let reg_data = match reg {
            IpcResponse::Json { data, .. } => data,
            other => panic!("unexpected register reply: {other:?}"),
        };
        let agent_id = reg_data["agent"]["id"].as_str().unwrap().to_string();
        let primary_kb_id = reg_data["primary_kb"]["id"].as_str().unwrap().to_string();

        // Authorize primary_kb -> kb_shared (1-hop), leave kb_secret unauthorized!
        {
            let guard = state.store.lock().unwrap();
            guard
                .upsert_kb_link(
                    &primary_kb_id,
                    &kb_shared.id,
                    KbLinkType::Cites,
                    LinkAuthority::HumanConfirmed,
                    0.95,
                    "引用发布规范",
                )
                .unwrap();
        }

        // 2. Client A saves explicit hard rule + confirmed English runbook + unauthorized secret item
        let _ = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "save_rule_or_preference".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({
                    "agentId": agent_id,
                    "scopeKind": "agent",
                    "constraintClass": "hard_rule",
                    "prefKey": "ui.shadows",
                    "content": "禁止给列表卡片添加装饰性阴影",
                    "humanExplicit": true
                }),
            },
        )
        .unwrap();

        let en_item_resp = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "propose_knowledge".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({
                    "kbId": kb_shared.id,
                    "itemType": "runbook",
                    "lang": "en-US",
                    "title": "Dual-OS Release Checklist",
                    "body": "Always confirm both Windows and macOS CI runs are green before tagging.",
                    "aliases": ["发版流程", "上线检查"],
                    "humanExplicit": true
                }),
            },
        )
        .unwrap();
        let en_item_id = match en_item_resp {
            IpcResponse::Json { data, .. } => data["item"]["id"].as_str().unwrap().to_string(),
            other => panic!("unexpected propose reply: {other:?}"),
        };

        let _ = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "propose_knowledge".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({
                    "kbId": kb_secret.id,
                    "itemType": "fact",
                    "title": "未授权发版流程机密",
                    "body": "发版流程 上线检查 绝密内容",
                    "humanExplicit": true
                }),
            },
        )
        .unwrap();

        // 3. Client A checkpoints a workstream referencing the confirmed runbook
        let cp_resp = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "checkpoint_workstream".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({
                    "agentId": agent_id,
                    "title": "M1 内核联调",
                    "goal": "打通跨客户端增量上下文注入",
                    "currentState": "SQLite 单库与 12 个 MCP 工具已就绪",
                    "decisions": [{"decision": "采用单 SQLite WAL", "reason": "后台常驻 < 25 MiB"}],
                    "nextSteps": ["在 Claude Code 中续跑检索验证"],
                    "reusedRefs": [{"kind": "kb_item", "id": en_item_id, "rev": 1, "note": "参考双端 CI 检查"}]
                }),
            },
        )
        .unwrap();
        let ws_id = match cp_resp {
            IpcResponse::Json { data, .. } => {
                data["workstream"]["id"].as_str().unwrap().to_string()
            }
            other => panic!("unexpected checkpoint reply: {other:?}"),
        };

        // 4. Client B (Claude Code) runs Hook Turn 1 in a subdirectory of the repo
        let hook1 = send_request(
            &ep,
            &IpcRequest::HookPrompt {
                client: "claude-code".into(),
                cwd: "t:/demo/fuli-core/crates/fuli-store".into(),
                session_id: Some("sess-claude-9".into()),
                event: Some("prompt".into()),
                user_prompt: Some("帮我接着做发版检查".into()),
            },
        )
        .unwrap();
        let pkt1 = match hook1 {
            IpcResponse::HookReply {
                packet: Some(p), ..
            } => p,
            other => panic!("unexpected hook1 reply: {other:?}"),
        };
        assert_eq!(pkt1["hard_rules"].as_array().unwrap().len(), 1);
        assert_eq!(pkt1["open_workstreams"].as_array().unwrap().len(), 1);
        assert_eq!(pkt1["dedup_skipped_count"].as_u64().unwrap(), 0);

        // 5. Client B runs Hook Turn 2 => ZERO duplicate rule injection!
        let hook2 = send_request(
            &ep,
            &IpcRequest::HookPrompt {
                client: "claude-code".into(),
                cwd: "t:/demo/fuli-core".into(),
                session_id: Some("sess-claude-9".into()),
                event: Some("prompt".into()),
                user_prompt: None,
            },
        )
        .unwrap();
        let pkt2 = match hook2 {
            IpcResponse::HookReply {
                packet: Some(p), ..
            } => p,
            other => panic!("unexpected hook2 reply: {other:?}"),
        };
        assert!(pkt2.get("hard_rules").is_none());
        assert_eq!(pkt2["dedup_skipped_count"].as_u64().unwrap(), 1);

        // 6. Client B explicitly resumes workstream created by Codex
        let resumed = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "resume_workstream".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-9".into()),
                arguments: json!({ "workstreamId": ws_id }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = resumed {
            assert_eq!(
                data["checkpoint"]["goal"].as_str(),
                Some("打通跨客户端增量上下文注入")
            );
            assert_eq!(
                data["checkpoint"]["next_steps"][0].as_str(),
                Some("在 Claude Code 中续跑检索验证")
            );
        } else {
            panic!("expected json from resume_workstream");
        }

        // 7. Client B searches in Chinese ("发版流程") -> hits 1-hop English runbook, ZERO secret leak!
        let search = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "search_knowledge".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-9".into()),
                arguments: json!({ "cwd": "t:/demo/fuli-core", "query": "发版流程" }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = search {
            let hits = data["hits"].as_array().unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0]["id"].as_str(), Some(en_item_id.as_str()));
            assert_eq!(hits[0]["hop"].as_u64(), Some(1));
        } else {
            panic!("expected json from search_knowledge");
        }

        // 8. Client B queries global portfolio summary (weekly report facts)
        let summary = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "query_portfolio_summary".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-9".into()),
                arguments: json!({ "sinceDays": 7 }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = summary {
            assert_eq!(data["total_agents"].as_u64(), Some(1));
            assert_eq!(data["compounding_events_count"].as_u64(), Some(1));
        } else {
            panic!("expected json from query_portfolio_summary");
        }

        // 9. Roundtable: Client B asks Client A -> Client A checks inbox
        let _ = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "ask_agent".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-9".into()),
                arguments: json!({
                    "agentId": agent_id,
                    "toClient": "codex",
                    "toSessionId": "sess-codex-1",
                    "question": "Windows 实测内存现在多少？",
                    "attemptNativeWake": false
                }),
            },
        )
        .unwrap();
        let inbox = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "check_inbox".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-1".into()),
                arguments: json!({ "onlyPending": true }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = inbox {
            assert_eq!(data["exchanges"].as_array().unwrap().len(), 1);
        } else {
            panic!("expected json from check_inbox");
        }

        let _ = send_request(&ep, &IpcRequest::Shutdown);
        server_thread.join().unwrap();
    }
}
