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
        // Keep serving IPC until an explicit Shutdown instead of exiting with the tray.
        while !state
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            thread::sleep(std::time::Duration::from_millis(200));
        }
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

    /// 3-Tier Cross-Client Roundtable E2E Test over Real Local IPC:
    /// 1. Client A (`codex`) asks a documented question -> Tier 0 (`memory_fast_path`) replies in 0 tokens!
    /// 2. Client A asks an undocumented live question targeting GUI client `cursor` (omitting `toSessionId` -> wildcard `*`) -> Tier 2 (`queued_inbox`).
    /// 3. Client B (`cursor`) fires `HookPrompt` Turn 1 -> receives `pending_inbox` piggybacked in packet + summary!
    /// 4. Client B (`cursor`) fires `HookPrompt` Turn 2 -> `pending_inbox` skipped via epoch dedup!
    /// 5. Client B replies via `check_inbox` (`replyExchangeId` + `answer`) -> Client A queries `check_inbox(onlyPending=false)` and reads the reply!
    #[test]
    fn roundtable_three_tier_memory_fast_path_and_hook_inbox_piggyback_over_ipc() {
        let ep = unique_ep("roundtable3");
        let store = FuliStore::open_in_memory().unwrap();
        let ui = UiProcessManager::new(None, ep.clone(), 0);
        let state = Arc::new(DaemonState::new(ep.clone(), ui, store, Box::new(|| {})));

        let srv_state = Arc::clone(&state);
        let server_thread = thread::spawn(move || {
            let _ = run_ipc_loop(srv_state);
        });
        thread::sleep(Duration::from_millis(60));

        // 1. Register FULI Bot and save confirmed knowledge + checkpoint
        let reg = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "register_agent".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-rt".into()),
                arguments: json!({
                    "name": "FULI Next",
                    "dirPath": "t:/demo/fuli-rt"
                }),
            },
        )
        .unwrap();
        let agent_id = match reg {
            IpcResponse::Json { data, .. } => data["agent"]["id"].as_str().unwrap().to_string(),
            other => panic!("unexpected register reply: {other:?}"),
        };

        let _ = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "checkpoint_workstream".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-claude-rt".into()),
                arguments: json!({
                    "agentId": agent_id,
                    "title": "圆桌三级路由协议",
                    "goal": "实现跨模型跨客户端三级路由",
                    "currentState": "Tier 0 记忆直答已通过单测，常驻内存稳定在 14 MiB",
                    "decisions": [{"decision": "优先零成本记忆直答", "reason": "避免无谓唤醒消耗额度"}],
                    "nextSteps": ["接入 Cursor Hook 顺手捎带信箱"]
                }),
            },
        )
        .unwrap();

        // 2. Client A (codex) asks about documented checkpoint -> Tier 0 answers immediately (0 tokens)!
        let fast_resp = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "ask_agent".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-rt".into()),
                arguments: json!({
                    "cwd": "t:/demo/fuli-rt",
                    "toClient": "claude-code",
                    "toSessionId": "sess-claude-rt",
                    "question": "圆桌三级路由常驻内存目前多少？"
                }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = fast_resp {
            assert_eq!(data["tier"].as_str(), Some("memory_fast_path"));
            assert_eq!(
                data["exchange"]["wake_status"].as_str(),
                Some("woken_replied")
            );
            assert!(
                data["exchange"]["answer"]
                    .as_str()
                    .unwrap()
                    .contains("14 MiB")
            );
            assert!(!data["sources"].as_array().unwrap().is_empty());
        } else {
            panic!("expected json from Tier-0 ask_agent");
        }

        // 3. Client A asks an undocumented live question targeting GUI client `cursor` (no toSessionId -> '*')
        let queued_resp = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "ask_agent".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-rt".into()),
                arguments: json!({
                    "agentId": agent_id,
                    "toClient": "cursor",
                    "question": "图标按钮颜色是按新版暖白调的吗？",
                    "attemptNativeWake": true
                }),
            },
        )
        .unwrap();
        let exchange_id = match queued_resp {
            IpcResponse::Json { data, .. } => {
                assert_eq!(data["tier"].as_str(), Some("queued_inbox"));
                assert_eq!(
                    data["exchange"]["wake_status"].as_str(),
                    Some("queued_inbox")
                );
                assert_eq!(
                    data["fallback_reason"].as_str(),
                    Some("client_or_session_requires_inbox")
                );
                data["exchange"]["id"].as_str().unwrap().to_string()
            }
            other => panic!("unexpected queued ask_agent reply: {other:?}"),
        };

        // 4. Client B (cursor) fires HookPrompt Turn 1 -> receives pending_inbox piggybacked!
        let hook1 = send_request(
            &ep,
            &IpcRequest::HookPrompt {
                client: "cursor".into(),
                cwd: "t:/demo/fuli-rt".into(),
                session_id: Some("sess-cursor-1".into()),
                event: Some("prompt".into()),
                user_prompt: Some("帮我检查样式".into()),
            },
        )
        .unwrap();
        match hook1 {
            IpcResponse::HookReply {
                summary,
                packet: Some(pkt),
                ..
            } => {
                assert!(summary.contains("FULI Bot:"));
                assert!(summary.contains("圆桌待回复 1 条"));
                let inbox = pkt["pending_inbox"].as_array().unwrap();
                assert_eq!(inbox.len(), 1);
                assert_eq!(inbox[0]["exchange_id"].as_str(), Some(exchange_id.as_str()));
            }
            other => panic!("unexpected cursor hook1 reply: {other:?}"),
        }

        // 5. Client B fires HookPrompt Turn 2 -> dedup skips pending_inbox!
        let hook2 = send_request(
            &ep,
            &IpcRequest::HookPrompt {
                client: "cursor".into(),
                cwd: "t:/demo/fuli-rt".into(),
                session_id: Some("sess-cursor-1".into()),
                event: Some("prompt".into()),
                user_prompt: None,
            },
        )
        .unwrap();
        match hook2 {
            IpcResponse::HookReply {
                packet: Some(pkt), ..
            } => {
                assert!(pkt.get("pending_inbox").is_none());
                assert_eq!(pkt["dedup_skipped_count"].as_u64(), Some(1));
            }
            other => panic!("unexpected cursor hook2 reply: {other:?}"),
        }

        // 6. Client B replies via check_inbox -> Client A verifies answer!
        let reply = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "check_inbox".into(),
                client: Some("cursor".into()),
                session_id: Some("sess-cursor-1".into()),
                arguments: json!({
                    "replyExchangeId": exchange_id,
                    "answer": "是的，全部统一到 canvas #F7F7F5 和暖金 #B38A4C。"
                }),
            },
        )
        .unwrap();
        assert!(matches!(reply, IpcResponse::Json { .. }));

        let fetched = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "check_inbox".into(),
                client: Some("codex".into()),
                session_id: Some("sess-codex-rt".into()),
                arguments: json!({
                    "targetClient": "cursor",
                    "onlyPending": false
                }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = fetched {
            let arr = data["exchanges"].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0]["wake_status"].as_str(), Some("woken_replied"));
            assert!(arr[0]["answer"].as_str().unwrap().contains("#F7F7F5"));
        } else {
            panic!("expected json from check_inbox fetch");
        }

        let _ = send_request(&ep, &IpcRequest::Shutdown);
        server_thread.join().unwrap();
    }

    /// FULI Concierge ("FULI 大管家") E2E over Real Local IPC:
    /// 1. Auto-routes natural-language intent to matching FULI Bot + latest session_id
    /// 2. Switching execution client generates a compact cross-client Handoff Brief
    /// 3. Global overview dispatch executes immediately (0 tokens) and populates `concierge_tasks` + `bot_session_ledgers`
    /// 4. Human correction persists route hint so future preview auto-picks the corrected Bot!
    #[test]
    fn concierge_preview_dispatch_switch_client_and_correction_over_ipc() {
        let ep = unique_ep("concierge");
        let store = FuliStore::open_in_memory().unwrap();
        let ui = UiProcessManager::new(None, ep.clone(), 0);
        let state = Arc::new(DaemonState::new(ep.clone(), ui, store, Box::new(|| {})));

        let srv_state = Arc::clone(&state);
        let server_thread = thread::spawn(move || {
            let _ = run_ipc_loop(srv_state);
        });
        thread::sleep(Duration::from_millis(60));

        // Seed 2 FULI Bots + 1 active session + 1 checkpoint
        let reg1 = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "register_agent".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-cc-main".into()),
                arguments: json!({
                    "name": "FULI Core",
                    "description": "Rust 内核与大管家",
                    "dirPath": "t:/demo/fuli-core"
                }),
            },
        )
        .unwrap();
        let bot1_id = match reg1 {
            IpcResponse::Json { data, .. } => data["agent"]["id"].as_str().unwrap().to_string(),
            other => panic!("unexpected reg1: {other:?}"),
        };
        let reg2 = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "register_agent".into(),
                client: Some("cursor".into()),
                session_id: Some("sess-cur-shop".into()),
                arguments: json!({
                    "name": "shop-web",
                    "description": "前端电商页面",
                    "dirPath": "t:/demo/shop-web"
                }),
            },
        )
        .unwrap();
        let bot2_id = match reg2 {
            IpcResponse::Json { data, .. } => data["agent"]["id"].as_str().unwrap().to_string(),
            other => panic!("unexpected reg2: {other:?}"),
        };

        let _ = send_request(
            &ep,
            &IpcRequest::ToolCall {
                tool: "checkpoint_workstream".into(),
                client: Some("claude-code".into()),
                session_id: Some("sess-cc-main".into()),
                arguments: json!({
                    "agentId": bot1_id,
                    "title": "大管家与三级路由",
                    "goal": "打通多会话管理",
                    "currentState": "核心后端已就绪",
                    "nextSteps": ["联调大管家界面"]
                }),
            },
        )
        .unwrap();

        // 1. Preview route with client switch -> detects FULI Core + builds Handoff Brief for Codex!
        let prev = send_request(
            &ep,
            &IpcRequest::UiAction {
                action: "concierge_preview".into(),
                payload: json!({
                    "prompt": "切到 codex 继续把 FULI Core 的大管家联调完"
                }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = prev {
            assert_eq!(data["selected_agent_id"].as_str(), Some(bot1_id.as_str()));
            assert_eq!(data["target_client"].as_str(), Some("codex"));
            assert_eq!(data["switched_from_client"].as_str(), Some("claude-code"));
            assert_eq!(data["mode"].as_str(), Some("switch_client_handoff"));
            assert!(
                data["handoff_brief_preview"]
                    .as_str()
                    .unwrap()
                    .contains("核心后端已就绪")
            );
        } else {
            panic!("expected json from concierge_preview");
        }

        // 2. Dispatch global overview -> instant 0-token task visible in DashboardSnapshot!
        let disp = send_request(
            &ep,
            &IpcRequest::UiAction {
                action: "concierge_dispatch".into(),
                payload: json!({
                    "prompt": "看看所有项目最近在干嘛"
                }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = disp {
            assert_eq!(data["async"].as_bool(), Some(false));
            assert_eq!(data["task"]["status"].as_str(), Some("completed"));
            assert!(
                data["task"]["result_preview"]
                    .as_str()
                    .unwrap()
                    .contains("FULI Core")
            );
        } else {
            panic!("expected json from concierge_dispatch");
        }

        // 3. DashboardSnapshot surfaces both `concierge_tasks` and `bot_session_ledgers`!
        let snap = send_request(&ep, &IpcRequest::DashboardSnapshot).unwrap();
        if let IpcResponse::Json { data, .. } = snap {
            assert_eq!(data["concierge_tasks"].as_array().unwrap().len(), 1);
            assert_eq!(data["bot_session_ledgers"].as_array().unwrap().len(), 2);
        } else {
            panic!("expected json from DashboardSnapshot");
        }

        // 4. User corrects route to `shop-web` -> future preview routes directly there!
        let corr = send_request(
            &ep,
            &IpcRequest::UiAction {
                action: "concierge_correct_route".into(),
                payload: json!({
                    "prompt": "把购物车结算按钮的圆角再调一下",
                    "agent_id": bot2_id
                }),
            },
        )
        .unwrap();
        assert!(matches!(corr, IpcResponse::Json { .. }));

        let prev2 = send_request(
            &ep,
            &IpcRequest::UiAction {
                action: "concierge_preview".into(),
                payload: json!({
                    "prompt": "购物车结算按钮颜色微调"
                }),
            },
        )
        .unwrap();
        if let IpcResponse::Json { data, .. } = prev2 {
            assert_eq!(data["selected_agent_id"].as_str(), Some(bot2_id.as_str()));
        } else {
            panic!("expected json from corrected concierge_preview");
        }

        let _ = send_request(&ep, &IpcRequest::Shutdown);
        server_thread.join().unwrap();
    }
}
