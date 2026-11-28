use std::fs;
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::time::Instant;

use fuli_adapters::{
    ClientKind, inspect_all_clients, remove_setup, resolve_fuli_cli_path, run_setup,
};
use fuli_ipc::{IpcRequest, IpcResponse, UiLifecycleState, resolve_ipc_name, send_request};
use serde_json::{Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        print_help();
        return;
    }

    let ipc_name = extract_flag(&args, "--ipc-name");
    let endpoint = resolve_ipc_name(ipc_name.as_deref());

    let code = match args[0].as_str() {
        "status" => cmd_status(&endpoint, has_flag(&args, "--json")),
        "doctor" => cmd_doctor(&endpoint),
        "open" => cmd_open(&endpoint),
        "stop" => cmd_stop(&endpoint),
        "hook" => cmd_hook(&endpoint, &args[1..]),
        "mcp" => cmd_mcp(&endpoint, &args[1..]),
        "report" => cmd_report(&endpoint, &args[1..]),
        "dreaming" => cmd_dreaming(&endpoint),
        "export" => cmd_export(&endpoint, &args[1..]),
        "import" => cmd_import(&endpoint, &args[1..]),
        "setup" => cmd_setup(&args[1..]),
        "ask" | "concierge" => cmd_ask(&endpoint, &args[1..]),
        "sync-sessions" => cmd_sync_sessions(&endpoint, &args[1..]),
        "log" | "logs" => cmd_log(&endpoint, &args[1..]),
        other => {
            eprintln!("Unknown command: {other}");
            print_help();
            2
        }
    };

    if code != 0 {
        std::process::exit(code);
    }
}

fn print_help() {
    println!(
        "fuli v{} — ultra-light CLI, Hook & MCP relay (zero SQLite / zero GPU)\n\n\
         USAGE:\n  \
           fuli status [--json] [--ipc-name NAME]\n  \
           fuli doctor [--ipc-name NAME]\n  \
           fuli open [--ipc-name NAME]\n  \
           fuli stop [--ipc-name NAME]\n  \
           fuli hook --client <name> [--event prompt|pre_compact|stop] [--cwd <path>] [--session <id>] [--prompt <text>]\n  \
           fuli mcp [--client <name>] [--session <id>] [--ipc-name NAME]\n  \
           fuli report [--days 7] [--json]\n  \
           fuli dreaming\n  \
           fuli export [--out <file.json>]\n  \
           fuli import --file <file.json> [--from-v1] [--dry-run]\n  \
           fuli log [--list] [--session ID] [--json]
  fuli setup --status | --client claude-code|codex|cursor|opencode [--apply | --remove] [--config <path>]\n  \
           fuli ask <prompt> [--bot <id|name>] [--client <claude-code|codex|opencode|cursor>] [--preview] [--write] [--json]\n  \
           fuli sync-sessions [--limit 40]",
        env!("CARGO_PKG_VERSION")
    );
}

fn extract_flag(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn cmd_doctor(endpoint: &str) -> i32 {
    println!(
        "FULI NEXT 健康体检（fuli doctor v{}）\n",
        env!("CARGO_PKG_VERSION")
    );

    let t0 = Instant::now();
    match send_request(endpoint, &IpcRequest::Ping) {
        Ok(IpcResponse::Pong {
            pid,
            memory,
            ui_pid,
            ui_state,
            uptime_secs,
            db_path,
            ..
        }) => {
            let rtt = t0.elapsed().as_secs_f64() * 1000.0;
            // Judge the 25 MiB line on private memory (macOS phys_footprint / Windows private
            // bytes): RSS / working set also count shared system framework pages.
            let mem_ok = if memory.private_mib() < 25.0 {
                "OK (< 25 MiB)"
            } else {
                "WARN (>= 25 MiB)"
            };
            println!(
                "  [OK] 后台服务 fuli-context 运行中 (PID {pid}, 运行 {uptime_secs}s, IPC {rtt:.2} ms)"
            );
            println!(
                "  [OK] 常驻内存：{:.2} MiB 工作集 / {:.2} MiB 私有 -> {mem_ok}",
                memory.working_set_mib(),
                memory.private_mib()
            );
            println!("  [OK] 单一数据库：{db_path}");
            let ui_desc = match (ui_pid, ui_state) {
                (Some(p), UiLifecycleState::Running) => format!("运行中 (PID {p})"),
                (Some(p), UiLifecycleState::GraceClosing) => format!("关窗宽限中 (PID {p})"),
                _ => "未启动 (0 MiB)".to_string(),
            };
            println!("  [OK] 桌面窗口 fuli-ui：{ui_desc}");
        }
        Ok(_) => println!("  [WARN] 收到意外的后台响应"),
        Err(err) => println!("  [OFF] 后台服务 fuli-context 尚未启动 ({err})"),
    }

    println!("\n  本机 AI 客户端接入与 CLI 状态：");
    for st in inspect_all_clients() {
        let mark = if st.fuli_configured {
            "[已接入]"
        } else if st.config_dir_exists {
            "[未接入]"
        } else {
            "[未检测]"
        };
        let cli_tag = if st.cli_available {
            "CLI 就绪"
        } else {
            "仅收件箱"
        };
        let legacy = if st.legacy_fuli_present {
            "（旧版 FULI 也在，不会动它）"
        } else {
            ""
        };
        println!(
            "    {mark} {:<12} ({cli_tag}) -> {}{legacy}",
            st.display_name, st.config_path
        );
    }
    0
}

fn cmd_ask(endpoint: &str, args: &[String]) -> i32 {
    let preview_only = has_flag(args, "--preview");
    let allow_write = has_flag(args, "--write");
    let as_json = has_flag(args, "--json");
    let bot = extract_flag(args, "--bot");
    let client = extract_flag(args, "--client");
    let session = extract_flag(args, "--session");

    let mut prompt_parts: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--bot" | "--client" | "--session" | "--ipc-name" => {
                i += 2;
            }
            "--preview" | "--write" | "--json" => {
                i += 1;
            }
            other => {
                prompt_parts.push(other);
                i += 1;
            }
        }
    }
    let prompt = prompt_parts.join(" ").trim().to_string();
    if prompt.is_empty() {
        eprintln!(
            "Usage: fuli ask \"<prompt>\" [--bot <id|name>] [--client <name>] [--preview] [--write] [--json]"
        );
        return 2;
    }

    let mut payload = json!({
        "prompt": prompt,
        "allow_write": allow_write,
    });
    if let Some(b) = bot {
        payload["override_agent_id"] = json!(b);
    }
    if let Some(c) = client {
        payload["override_client"] = json!(c);
    }
    if let Some(s) = session {
        payload["override_session_id"] = json!(s);
    }

    let tool = if preview_only {
        "concierge_preview"
    } else {
        "concierge_dispatch"
    };
    match send_request(
        endpoint,
        &IpcRequest::ToolCall {
            tool: tool.into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: payload,
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => {
            if as_json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
                );
            } else if preview_only {
                println!(
                    "FULI 大管家路由预览：\n  项目 (FULI Bot): {} ({}% 把握)\n  原因: {}\n  客户端 / 会话: {} ({})\n  工作目录: {}\n  策略: {} · {}",
                    data["selected_agent_name"].as_str().unwrap_or("—"),
                    data["confidence"].as_u64().unwrap_or(0),
                    data["reason"].as_str().unwrap_or("—"),
                    data["target_client"].as_str().unwrap_or("—"),
                    data["target_session_id"].as_str().unwrap_or("*"),
                    data["working_dir"].as_str().unwrap_or("未绑定目录"),
                    data["mode"].as_str().unwrap_or("—"),
                    if data["allow_write"].as_bool().unwrap_or(false) {
                        "允许改代码"
                    } else {
                        "只读安全"
                    },
                );
                if let Some(brief) = data["handoff_brief_preview"].as_str() {
                    println!("\n跨端接力简报预览：\n{brief}");
                }
            } else {
                let task = &data["task"];
                println!(
                    "FULI 大管家 · [{} -> {} ({})]\n  状态: {}",
                    task["agent_name"].as_str().unwrap_or("—"),
                    task["target_client"].as_str().unwrap_or("—"),
                    task["target_session_id"].as_str().unwrap_or("*"),
                    task["step_label"].as_str().unwrap_or("—"),
                );
                if let Some(ans) = task["result_preview"].as_str() {
                    println!("\n{ans}");
                } else if data["async"].as_bool().unwrap_or(false) {
                    println!("  (后台执行中，打开 `fuli open` 可在大管家右侧实时查看进度)");
                }
            }
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Concierge error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_sync_sessions(endpoint: &str, args: &[String]) -> i32 {
    let limit: u64 = extract_flag(args, "--limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(40);
    match send_request(
        endpoint,
        &IpcRequest::ToolCall {
            tool: "sync_local_sessions".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({ "limit": limit }),
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => {
            println!(
                "已扫描本机 {} 条客户端历史会话：新导入 {} 条，自动关联到 FULI Bot {} 条。",
                data["scanned"].as_u64().unwrap_or(0),
                data["imported"].as_u64().unwrap_or(0),
                data["matched_bots"].as_u64().unwrap_or(0),
            );
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Sync error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_status(endpoint: &str, as_json: bool) -> i32 {
    let t0 = Instant::now();
    match send_request(endpoint, &IpcRequest::Ping) {
        Ok(IpcResponse::Pong {
            version,
            pid,
            memory,
            ui_pid,
            ui_state,
            uptime_secs,
            db_path,
        }) => {
            let rtt_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if as_json {
                println!(
                    "{}",
                    json!({
                        "status": "running",
                        "version": version,
                        "pid": pid,
                        "working_set_mib": round2(memory.working_set_mib()),
                        "private_mib": round2(memory.private_mib()),
                        "ui_pid": ui_pid,
                        "ui_state": ui_state,
                        "uptime_secs": uptime_secs,
                        "db_path": db_path,
                        "ipc_rtt_ms": round2(rtt_ms),
                    })
                );
            } else {
                let ui_desc = match (ui_pid, ui_state) {
                    (Some(upid), UiLifecycleState::Running) => format!("open (pid {upid})"),
                    (Some(upid), UiLifecycleState::GraceClosing) => {
                        format!("closing grace (pid {upid})")
                    }
                    _ => "stopped (0 MiB)".to_string(),
                };
                println!(
                    "fuli-context v{version} (pid {pid}) · running\n  \
                     memory:  {:.2} MiB working set / {:.2} MiB private\n  \
                     ui:      {ui_desc}\n  \
                     db:      {db_path}\n  \
                     uptime:  {uptime_secs}s (IPC {:.2} ms)",
                    memory.working_set_mib(),
                    memory.private_mib(),
                    rtt_ms
                );
            }
            0
        }
        Ok(other) => {
            eprintln!("Unexpected response from fuli-context: {other:?}");
            1
        }
        Err(err) => {
            if as_json {
                println!(
                    "{}",
                    json!({ "status": "stopped", "error": err.to_string() })
                );
            } else {
                eprintln!("fuli-context is not running ({err})");
            }
            1
        }
    }
}

fn cmd_open(endpoint: &str) -> i32 {
    match send_request(endpoint, &IpcRequest::OpenUi) {
        Ok(IpcResponse::UiOpened {
            pid,
            already_running,
        }) => {
            if already_running {
                println!("fuli-ui already running (pid {pid})");
            } else {
                println!("fuli-ui launched (pid {pid})");
            }
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Failed to open UI ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_stop(endpoint: &str) -> i32 {
    match send_request(endpoint, &IpcRequest::Shutdown) {
        Ok(IpcResponse::Ack) => {
            println!("fuli-context stopped");
            0
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

/// Hook payload a host (Claude Code / Codex) writes to the hook's stdin.
#[derive(Debug, Default, PartialEq)]
struct HostHookInput {
    session_id: Option<String>,
    cwd: Option<String>,
    prompt: Option<String>,
    event: Option<String>,
}

fn non_empty_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse the host hook JSON. Returns `None` when stdin is not a host payload.
fn parse_host_hook_input(raw: &str) -> Option<HostHookInput> {
    let v: Value = serde_json::from_str(raw.trim()).ok()?;
    if !v.is_object() {
        return None;
    }
    let event = non_empty_str(&v, "hook_event_name").map(|name| match name.as_str() {
        "UserPromptSubmit" => "prompt".to_string(),
        "PreCompact" => "pre_compact".to_string(),
        "Stop" | "SubagentStop" => "stop".to_string(),
        other => other.to_string(),
    });
    Some(HostHookInput {
        session_id: non_empty_str(&v, "session_id"),
        cwd: non_empty_str(&v, "cwd"),
        prompt: non_empty_str(&v, "prompt"),
        event,
    })
}

fn read_host_hook_stdin() -> Option<HostHookInput> {
    use std::io::{IsTerminal, Read};
    let stdin = io::stdin();
    if stdin.is_terminal() {
        return None;
    }
    let mut raw = String::new();
    stdin
        .lock()
        .take(1024 * 1024)
        .read_to_string(&mut raw)
        .ok()?;
    parse_host_hook_input(&raw)
}

fn card_lines(packet: &Value, key: &str) -> Vec<String> {
    packet
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|c| non_empty_str(c, "content"))
                .map(|c| format!("- {c}"))
                .collect()
        })
        .unwrap_or_default()
}

/// Render the plain-language context a host model should actually read this turn.
/// Empty when nothing new needs injecting (dedup already delivered it).
fn render_hook_context(packet: &Value) -> String {
    let mut sections = Vec::new();
    let rules = card_lines(packet, "hard_rules");
    if !rules.is_empty() {
        sections.push(format!("必须遵守：\n{}", rules.join("\n")));
    }
    let prefs = card_lines(packet, "preferences");
    if !prefs.is_empty() {
        sections.push(format!("用户习惯：\n{}", prefs.join("\n")));
    }
    if let Some(items) = packet.get("pending_inbox").and_then(Value::as_array) {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|c| {
                let q = non_empty_str(c, "question")?;
                let from = non_empty_str(c, "from_client").unwrap_or_else(|| "其他客户端".into());
                let id = non_empty_str(c, "exchange_id").unwrap_or_default();
                Some(format!(
                    "- 来自 {from}：{q}（回复时调用 check_inbox，replyExchangeId={id}）"
                ))
            })
            .collect();
        if !lines.is_empty() {
            sections.push(format!("圆桌有人在等你回复：\n{}", lines.join("\n")));
        }
    }
    if let Some(items) = packet.get("open_workstreams").and_then(Value::as_array) {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|c| non_empty_str(c, "title"))
            .map(|t| format!("- {t}"))
            .collect();
        if !lines.is_empty() {
            sections.push(format!("进行中的工作线：\n{}", lines.join("\n")));
        }
    }
    if sections.is_empty() {
        return String::new();
    }
    format!("[FULI]\n{}", sections.join("\n\n"))
}

/// Host-native hook stdout. Claude Code / Codex drop JSON stdout that does not
/// follow their hook schema, so the context must go in `additionalContext`.
fn host_hook_output(event: &str, packet: &Value) -> Option<Value> {
    if event != "prompt" {
        return None;
    }
    let context = render_hook_context(packet);
    if context.is_empty() {
        return None;
    }
    Some(json!({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }))
}

fn cmd_hook(endpoint: &str, args: &[String]) -> i32 {
    let host = read_host_hook_stdin();
    let from_host = host.is_some();
    let host = host.unwrap_or_default();
    let client = extract_flag(args, "--client").unwrap_or_else(|| "unknown".into());
    let event = extract_flag(args, "--event").or(host.event);
    let cwd = extract_flag(args, "--cwd").or(host.cwd).unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default()
    });
    let session_id = extract_flag(args, "--session").or(host.session_id);
    let user_prompt = extract_flag(args, "--prompt").or(host.prompt);
    let event_name = event.clone().unwrap_or_else(|| "prompt".into());

    let t0 = Instant::now();
    match send_request(
        endpoint,
        &IpcRequest::HookPrompt {
            client,
            cwd,
            session_id,
            event,
            user_prompt,
        },
    ) {
        Ok(IpcResponse::HookReply {
            elapsed_us,
            summary,
            packet,
        }) => {
            let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if from_host {
                // Host mode: stdout is read by the AI client, keep it schema-clean.
                if let Some(out) = packet
                    .as_ref()
                    .and_then(|p| host_hook_output(&event_name, p))
                {
                    println!("{out}");
                }
                return 0;
            }
            println!(
                "{}",
                json!({
                    "ok": true,
                    "summary": summary,
                    "packet": packet,
                    "daemon_us": elapsed_us,
                    "total_ms": round2(total_ms),
                })
            );
            0
        }
        // A hook must never block the user's prompt: in host mode report on stderr, exit 0.
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Hook error ({code}): {message}");
            i32::from(!from_host)
        }
        Ok(other) => {
            eprintln!("Unexpected hook response: {other:?}");
            i32::from(!from_host)
        }
        Err(err) => {
            eprintln!("Hook could not reach fuli-context: {err}");
            i32::from(!from_host)
        }
    }
}

fn cmd_report(endpoint: &str, args: &[String]) -> i32 {
    let days: u64 = extract_flag(args, "--days")
        .and_then(|s| s.parse().ok())
        .unwrap_or(7);
    let as_json = has_flag(args, "--json");
    match send_request(
        endpoint,
        &IpcRequest::ToolCall {
            tool: "query_portfolio_summary".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({ "sinceDays": days }),
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => {
            if as_json {
                println!("{data}");
            } else {
                println!(
                    "FULI 近 {days} 天复利汇总\n  \
                     活跃项目 (FULI Bot): {}\n  \
                     进行中 / 已完成工作线: {} / {}\n  \
                     复利生效次数: {}\n  \
                     新增确认知识: {}\n  \
                     待拍板建议: {}",
                    data["total_agents"],
                    data["active_workstreams"],
                    data["completed_workstreams"],
                    data["compounding_events_count"],
                    data["new_confirmed_knowledge"],
                    data["pending_proposals_count"],
                );
            }
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Report error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_dreaming(endpoint: &str) -> i32 {
    match send_request(
        endpoint,
        &IpcRequest::ToolCall {
            tool: "run_dreaming".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({}),
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
            );
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Dreaming error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_export(endpoint: &str, args: &[String]) -> i32 {
    let out_file = extract_flag(args, "--out");
    match send_request(
        endpoint,
        &IpcRequest::ToolCall {
            tool: "export_portable".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({}),
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => {
            let pretty = serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string());
            if let Some(path) = out_file {
                if let Err(err) = fs::write(&path, pretty) {
                    eprintln!("Failed to write {path}: {err}");
                    return 1;
                }
                println!("Exported portable FULI bundle to {path}");
            } else {
                println!("{pretty}");
            }
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Export error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_import(endpoint: &str, args: &[String]) -> i32 {
    let Some(path) = extract_flag(args, "--file") else {
        eprintln!("Missing required --file <path>");
        return 2;
    };
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("Cannot read {path}: {err}");
            return 1;
        }
    };
    let from_v1 = has_flag(args, "--from-v1");
    let dry_run = has_flag(args, "--dry-run");
    let req = if from_v1 {
        IpcRequest::ToolCall {
            tool: "import_v1_json".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({ "rawJson": raw, "dryRun": dry_run }),
        }
    } else {
        let bundle: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(err) => {
                eprintln!("Invalid JSON in {path}: {err}");
                return 1;
            }
        };
        IpcRequest::ToolCall {
            tool: "import_portable".into(),
            client: Some("cli".into()),
            session_id: None,
            arguments: json!({ "bundle": bundle, "dryRun": dry_run }),
        }
    };

    match send_request(endpoint, &req) {
        Ok(IpcResponse::Json { data, .. }) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
            );
            0
        }
        Ok(IpcResponse::Error { code, message }) => {
            eprintln!("Import error ({code}): {message}");
            1
        }
        Ok(other) => {
            eprintln!("Unexpected response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Cannot reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_setup(args: &[String]) -> i32 {
    if has_flag(args, "--status") {
        for st in inspect_all_clients() {
            let state = if st.fuli_configured {
                "configured"
            } else if st.config_dir_exists {
                "not_configured"
            } else {
                "not_installed"
            };
            let legacy = if st.legacy_fuli_present {
                "  (v1 fuli present, untouched)"
            } else {
                ""
            };
            println!(
                "{:<12} {:<15} {}{legacy}",
                st.display_name, state, st.config_path
            );
        }
        return 0;
    }

    let raw_client = extract_flag(args, "--client").unwrap_or_else(|| "claude-code".into());
    let Some(client) = ClientKind::parse(&raw_client) else {
        eprintln!(
            "Unsupported client '{raw_client}'. Supported: claude-code, codex, cursor, opencode"
        );
        return 2;
    };
    let apply = has_flag(args, "--apply");
    let remove = has_flag(args, "--remove");
    let cfg_override = extract_flag(args, "--config");
    let explicit_bin = extract_flag(args, "--bin");
    let fuli_bin = resolve_fuli_cli_path(explicit_bin.as_deref());

    let res = if remove {
        remove_setup(client, cfg_override.as_deref().map(Path::new), apply)
    } else {
        run_setup(
            client,
            cfg_override.as_deref().map(Path::new),
            &fuli_bin,
            apply,
        )
    };

    match res {
        Ok(plan) => {
            if plan.already_in_desired_state {
                println!(
                    "No change needed for {} in {}",
                    plan.client.canonical_name(),
                    plan.target_path.display()
                );
            } else if plan.applied {
                println!(
                    "{} FULI for {} -> {}",
                    if remove { "Removed" } else { "Configured" },
                    plan.client.canonical_name(),
                    plan.target_path.display()
                );
                if let Some(bak) = plan.backup_path {
                    println!("Backup saved to {}", bak.display());
                }
            } else {
                println!(
                    "[DRY-RUN] {} preview for {} -> {} (re-run with --apply to write, backup created automatically):\n\n{}",
                    if remove { "Removal" } else { "Setup" },
                    plan.client.canonical_name(),
                    plan.target_path.display(),
                    plan.updated_content
                );
                for cmd in &plan.commands {
                    println!("[DRY-RUN] will also run: {}", cmd.join(" "));
                }
            }
            0
        }
        Err(err) => {
            eprintln!("Setup failed: {err}");
            1
        }
    }
}

fn mcp_tool_definitions() -> Value {
    json!([
        {
            "name": "resolve_context",
            "description": "Identify the active FULI Bot for cwd, deliver incremental hard rules, preferences, and unread Roundtable inbox questions (zero duplicate injection within session epoch), and list open workstream titles.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cwd": { "type": "string" },
                    "agentId": { "type": "string" },
                    "sessionId": { "type": "string" },
                    "workKind": { "type": "string" },
                    "userPrompt": { "type": "string" },
                    "forceFull": { "type": "boolean" }
                },
                "required": ["cwd"]
            }
        },
        {
            "name": "list_workstreams",
            "description": "List active, paused, or all workstreams and their latest checkpoint summaries for the active FULI Agent.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "status": { "type": "string", "enum": ["open", "all"] },
                    "limit": { "type": "integer" }
                }
            }
        },
        {
            "name": "resume_workstream",
            "description": "Load the structured latest checkpoint (goal, current_state, decisions, next_steps) for an open workstream without raw chat replay.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workstreamId": { "type": "string" },
                    "sessionId": { "type": "string" }
                },
                "required": ["workstreamId"]
            }
        },
        {
            "name": "checkpoint_workstream",
            "description": "Save a structured progress checkpoint and automatically record compounding events for reused rules or knowledge items.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "workstreamId": { "type": "string" },
                    "title": { "type": "string" },
                    "status": { "type": "string", "enum": ["active", "paused", "done"] },
                    "goal": { "type": "string" },
                    "currentState": { "type": "string" },
                    "decisions": { "type": "array" },
                    "nextSteps": { "type": "array", "items": { "type": "string" } },
                    "reusedRefs": { "type": "array" }
                },
                "required": ["goal"]
            }
        },
        {
            "name": "search_knowledge",
            "description": "Bilingual (CN/EN) authorized hybrid search across 1-6 focused queries, spanning the agent's primary KB and 1-2 hop human-confirmed linked KBs with strict byte budget and zero unauthorized leaks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "queries": { "type": "array", "items": { "type": "string" }, "maxItems": 6 },
                    "itemTypes": { "type": "array", "items": { "type": "string", "enum": ["fact", "runbook", "experience", "decision"] } },
                    "cwd": { "type": "string" },
                    "agentId": { "type": "string" },
                    "kbId": { "type": "string" },
                    "limit": { "type": "integer" },
                    "byteBudget": { "type": "integer" },
                    "includeProposals": { "type": "boolean" }
                }
            }
        },
        {
            "name": "get_knowledge_item",
            "description": "Inspect full content, revision history, and linked edges for a specific knowledge item.",
            "inputSchema": {
                "type": "object",
                "properties": { "itemId": { "type": "string" } },
                "required": ["itemId"]
            }
        },
        {
            "name": "propose_knowledge",
            "description": "Record or update a fact, runbook, experience, or decision with version preservation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kbId": { "type": "string" },
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "stableKey": { "type": "string" },
                    "itemType": { "type": "string", "enum": ["fact", "runbook", "experience", "decision"] },
                    "lang": { "type": "string" },
                    "title": { "type": "string" },
                    "body": { "type": "string" },
                    "contextSummary": { "type": "string" },
                    "aliases": { "type": "array", "items": { "type": "string" } },
                    "humanExplicit": { "type": "boolean" }
                },
                "required": ["title", "body"]
            }
        },
        {
            "name": "save_rule_or_preference",
            "description": "Save a personal-global or project-specific hard rule or soft preference. Explicit human statements activate cleanly; AI proposals queue for human review.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "scopeKind": { "type": "string", "enum": ["personal_global", "agent"] },
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "constraintClass": { "type": "string", "enum": ["hard_rule", "preference"] },
                    "aspect": { "type": "string", "enum": ["hard_rule", "taste", "personality", "judgment"] },
                    "prefKey": { "type": "string" },
                    "content": { "type": "string" },
                    "rationale": { "type": "string" },
                    "workKinds": { "type": "array", "items": { "type": "string" } },
                    "humanExplicit": { "type": "boolean" }
                },
                "required": ["content"]
            }
        },
        {
            "name": "manage_workflow",
            "description": "List, propose, update, or record runs for FULI Agent reusable Workflows.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "upsert", "record_run"] },
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "workflowId": { "type": "string" },
                    "title": { "type": "string" },
                    "summary": { "type": "string" },
                    "steps": { "type": "array", "items": { "type": "string" } },
                    "passed": { "type": "boolean" }
                },
                "required": ["op"]
            }
        },
        {
            "name": "session_control",
            "description": "Pause capture, disable FULI for this session, restore normal mode, or bump context_epoch on PreCompact.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["normal", "capture_paused", "disabled", "pre_compact"] },
                    "sessionId": { "type": "string" }
                },
                "required": ["mode"]
            }
        },
        {
            "name": "query_portfolio_summary",
            "description": "Global cross-project summary of recent workstreams, compounding events, and confirmed knowledge for daily/weekly reports.",
            "inputSchema": {
                "type": "object",
                "properties": { "sinceDays": { "type": "integer" } }
            }
        },
        {
            "name": "ask_agent",
            "description": "3-tier cross-client Roundtable Q&A: Tier 0 answers in <5ms / 0 tokens from target FULI Bot checkpoints & confirmed KB; Tier 1 optionally runs bounded read-only CLI wake (claude-code/codex/opencode); Tier 2 queues honestly in local inbox piggybacked onto target's next Hook or MCP turn.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "toClient": { "type": "string" },
                    "toSessionId": { "type": "string", "description": "Optional target session_id; omit or pass '*' to target any active session on toClient." },
                    "question": { "type": "string" },
                    "allowMemoryFastPath": { "type": "boolean", "description": "Default true: check target Bot memory & checkpoints first (0 tokens)." },
                    "forceWake": { "type": "boolean", "description": "Skip Tier-0 memory fast-path and request live Tier-1 wake / Tier-2 inbox." },
                    "attemptNativeWake": { "type": "boolean" },
                    "wakeTimeoutMs": { "type": "integer" }
                },
                "required": ["toClient", "question"]
            }
        },
        {
            "name": "check_inbox",
            "description": "Check or reply to pending Roundtable questions addressed to this client session or FULI Bot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "onlyPending": { "type": "boolean" },
                    "targetClient": { "type": "string" },
                    "targetSessionId": { "type": "string" },
                    "agentId": { "type": "string" },
                    "cwd": { "type": "string" },
                    "replyExchangeId": { "type": "string" },
                    "answer": { "type": "string" }
                }
            }
        }
    ])
}

fn ui_action(endpoint: &str, action: &str, payload: Value) -> Result<Value, String> {
    match send_request(
        endpoint,
        &IpcRequest::UiAction {
            action: action.into(),
            payload,
        },
    ) {
        Ok(IpcResponse::Json { data, .. }) => Ok(data),
        Ok(IpcResponse::Error { message, .. }) => Err(message),
        Ok(other) => Err(format!("unexpected reply: {other:?}")),
        Err(err) => Err(format!("cannot reach fuli-context: {err}")),
    }
}

/// Terminal run log: one line per step with a coloured tag, grouped by trace.
fn cmd_log(endpoint: &str, args: &[String]) -> i32 {
    let as_json = has_flag(args, "--json");
    let color = !as_json && std::io::IsTerminal::is_terminal(&std::io::stdout());
    let paint = |code: &str, text: &str| {
        if color {
            format!("\x1b[{code}m{text}\x1b[0m")
        } else {
            text.to_string()
        }
    };
    let sessions = match ui_action(endpoint, "run_sessions", json!({ "limit": 50 })) {
        Ok(v) => v["sessions"].as_array().cloned().unwrap_or_default(),
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let want = extract_flag(args, "--session");
    let picked: Vec<&Value> = match &want {
        Some(id) => sessions
            .iter()
            .filter(|s| {
                s["session_id"]
                    .as_str()
                    .is_some_and(|x| x.starts_with(id.as_str()))
            })
            .collect(),
        None if has_flag(args, "--list") => {
            for s in &sessions {
                println!(
                    "{}  {:<12} {:<10} {:>3} 次 · {:>3} 步 · ~{} tok  {}",
                    s["last_at"].as_str().unwrap_or(""),
                    s["client_id"].as_str().unwrap_or(""),
                    s["session_id"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(8)
                        .collect::<String>(),
                    s["traces"],
                    s["steps"],
                    s["tokens_est"],
                    s["agent_name"].as_str().unwrap_or("未绑定项目")
                );
            }
            return 0;
        }
        None => sessions.iter().take(1).collect(),
    };
    if picked.is_empty() {
        println!("还没有运行记录。AI 客户端用一次 FULI 之后再来看。");
        return 0;
    }
    for sess in picked {
        let client = sess["client_id"].as_str().unwrap_or("");
        let sid = sess["session_id"].as_str().unwrap_or("");
        let steps = match ui_action(
            endpoint,
            "run_steps",
            json!({ "client": client, "session": sid }),
        ) {
            Ok(v) => v["steps"].as_array().cloned().unwrap_or_default(),
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        if as_json {
            println!("{}", json!({ "session": sess, "steps": steps }));
            continue;
        }
        println!(
            "{} {} · {} · {}",
            paint("1", "●"),
            paint("1", client),
            sid,
            sess["agent_name"].as_str().unwrap_or("未绑定项目")
        );
        let mut last_trace = "";
        for st in &steps {
            let trace = st["trace_id"].as_str().unwrap_or("");
            let tag = st["tag"].as_str().unwrap_or("");
            if trace != last_trace {
                let ms = st["duration_us"].as_f64().unwrap_or(0.0) / 1000.0;
                println!(
                    "\n  {}  {}  {}",
                    paint(
                        "2",
                        st["created_at"]
                            .as_str()
                            .unwrap_or("")
                            .get(11..19)
                            .unwrap_or("")
                    ),
                    paint(
                        "2",
                        if st["source"] == "hook" {
                            "Hook"
                        } else {
                            "MCP "
                        }
                    ),
                    paint("2", &format!("{ms:.2} ms"))
                );
                last_trace = trace;
            }
            let code = match tag {
                "trigger" => "1;37;44",
                "project" => "1;30;46",
                "rules" | "inbox" | "workstream" => "1;30;43",
                "dedup" | "skip" | "miss" => "1;37;100",
                "search" | "hit" => "1;30;42",
                "write" | "epoch" => "1;37;45",
                "error" => "1;37;41",
                _ => "1;30;47",
            };
            let detail = st["detail"].as_str().unwrap_or("");
            println!(
                "    {} {}{}",
                paint(code, &format!(" {tag:<10} ")),
                st["title"].as_str().unwrap_or(""),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\n                 {}", paint("2", detail))
                }
            );
        }
        println!();
    }
    0
}

fn cmd_mcp(endpoint: &str, args: &[String]) -> i32 {
    let default_client = extract_flag(args, "--client").unwrap_or_else(|| "mcp".into());
    // Hosts expose their real session id to the MCP child process; using it puts Hook and
    // MCP steps of one conversation into the same run-log session.
    let default_session = extract_flag(args, "--session")
        .or_else(|| {
            [
                "CLAUDE_CODE_SESSION_ID",
                "CODEX_SESSION_ID",
                "CODEX_THREAD_ID",
            ]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
        })
        .unwrap_or_else(|| "mcp-default".into());
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let Ok(raw) = line else { break };
        if raw.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");

        let Some(reply_id) = id else {
            continue;
        };

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": reply_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": { "name": "fuli-context", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "tools": {} },
                    "instructions": "FULI pure-local Rust context kernel. Call resolve_context at task start, search_knowledge on demand, and checkpoint_workstream when milestones finish."
                }
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": reply_id, "result": {} }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": reply_id,
                "result": { "tools": mcp_tool_definitions() }
            }),
            "tools/call" => {
                let tool = req
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let arguments = req
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));

                match send_request(
                    endpoint,
                    &IpcRequest::ToolCall {
                        tool,
                        client: Some(default_client.clone()),
                        session_id: Some(default_session.clone()),
                        arguments,
                    },
                ) {
                    Ok(IpcResponse::Json { data, .. }) => json!({
                        "jsonrpc": "2.0",
                        "id": reply_id,
                        "result": {
                            "content": [{ "type": "text", "text": data.to_string() }]
                        }
                    }),
                    Ok(IpcResponse::Error { code, message }) => json!({
                        "jsonrpc": "2.0",
                        "id": reply_id,
                        "error": { "code": -32001, "message": format!("{code}: {message}") }
                    }),
                    Ok(other) => json!({
                        "jsonrpc": "2.0",
                        "id": reply_id,
                        "error": { "code": -32603, "message": format!("unexpected reply: {other:?}") }
                    }),
                    Err(err) => json!({
                        "jsonrpc": "2.0",
                        "id": reply_id,
                        "error": { "code": -32000, "message": format!("fuli-context unreachable: {err}") }
                    }),
                }
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": reply_id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }),
        };

        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
    0
}

fn round2(val: f64) -> f64 {
    (val * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_cli_flags_and_exposes_exactly_13_clean_mcp_tools() {
        let args = vec![
            "hook".into(),
            "--client".into(),
            "codex".into(),
            "--cwd".into(),
            "t:/workspace/fuli".into(),
        ];
        assert_eq!(extract_flag(&args, "--client").as_deref(), Some("codex"));
        assert_eq!(
            extract_flag(&args, "--cwd").as_deref(),
            Some("t:/workspace/fuli")
        );
        assert_eq!(extract_flag(&args, "--session"), None);

        let tools = mcp_tool_definitions();
        let arr = tools.as_array().unwrap();
        assert_eq!(arr.len(), 13);
    }

    #[test]
    fn parses_claude_code_hook_stdin() {
        let raw = r#"{"session_id":"abc-123","cwd":"/tmp/p","prompt":"hi","hook_event_name":"UserPromptSubmit"}"#;
        let got = parse_host_hook_input(raw).unwrap();
        assert_eq!(got.session_id.as_deref(), Some("abc-123"));
        assert_eq!(got.cwd.as_deref(), Some("/tmp/p"));
        assert_eq!(got.prompt.as_deref(), Some("hi"));
        assert_eq!(got.event.as_deref(), Some("prompt"));
        let compact = parse_host_hook_input(r#"{"hook_event_name":"PreCompact"}"#).unwrap();
        assert_eq!(compact.event.as_deref(), Some("pre_compact"));
        assert!(parse_host_hook_input("not json").is_none());
        assert!(parse_host_hook_input("[1]").is_none());
    }

    #[test]
    fn host_output_uses_additional_context_and_stays_silent_when_deduped() {
        let packet = json!({
            "hard_rules": [{"content": "回复使用中文"}],
            "pending_inbox": [{"exchange_id": "x1", "from_client": "codex", "question": "接口改了吗？"}]
        });
        let out = host_hook_output("prompt", &packet).unwrap();
        let ctx = out
            .pointer("/hookSpecificOutput/additionalContext")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(
            out.pointer("/hookSpecificOutput/hookEventName").unwrap(),
            "UserPromptSubmit"
        );
        assert!(ctx.contains("回复使用中文"));
        assert!(ctx.contains("replyExchangeId=x1"));
        assert!(host_hook_output("prompt", &json!({"dedup_skipped_count": 3})).is_none());
        assert!(host_hook_output("pre_compact", &packet).is_none());
    }
}
