use std::io::{self, BufRead, Write};
use std::time::Instant;

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
        "status" => cmd_status(&endpoint, args.iter().any(|a| a == "--json")),
        "open" => cmd_open(&endpoint),
        "stop" => cmd_stop(&endpoint),
        "hook" => cmd_hook(&endpoint, &args[1..]),
        "mcp" => cmd_mcp(&endpoint),
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
        "fuli v{} — ultra-light CLI, Hook & MCP relay\n\n\
         USAGE:\n  \
           fuli status [--json] [--ipc-name NAME]\n  \
           fuli open [--ipc-name NAME]\n  \
           fuli stop [--ipc-name NAME]\n  \
           fuli hook --client <name> [--cwd <path>] [--session <id>] [--ipc-name NAME]\n  \
           fuli mcp [--ipc-name NAME]",
        env!("CARGO_PKG_VERSION")
    );
}

fn extract_flag(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
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

fn cmd_hook(endpoint: &str, args: &[String]) -> i32 {
    let client = extract_flag(args, "--client").unwrap_or_else(|| "unknown".into());
    let cwd = extract_flag(args, "--cwd").unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.display().to_string())
            .unwrap_or_default()
    });
    let session_id = extract_flag(args, "--session");

    let t0 = Instant::now();
    match send_request(
        endpoint,
        &IpcRequest::HookPrompt {
            client,
            cwd,
            session_id,
        },
    ) {
        Ok(IpcResponse::HookReply {
            elapsed_us,
            summary,
        }) => {
            let total_ms = t0.elapsed().as_secs_f64() * 1000.0;
            println!(
                "{}",
                json!({
                    "ok": true,
                    "summary": summary,
                    "daemon_us": elapsed_us,
                    "total_ms": round2(total_ms),
                })
            );
            0
        }
        Ok(other) => {
            eprintln!("Unexpected hook response: {other:?}");
            1
        }
        Err(err) => {
            eprintln!("Hook could not reach fuli-context: {err}");
            1
        }
    }
}

fn cmd_mcp(endpoint: &str) -> i32 {
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

        // Notifications carry no id and expect no reply.
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
                    "instructions": "FULI v2 local context kernel. Call resolve_context at task start and search_knowledge on demand."
                }
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": reply_id, "result": {} }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": reply_id,
                "result": {
                    "tools": [
                        {
                            "name": "resolve_context",
                            "description": "Identify the active project unit, effective rules/preferences delta, and open workstreams.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "cwd": { "type": "string" },
                                    "sessionId": { "type": "string" }
                                },
                                "required": ["cwd"]
                            }
                        }
                    ]
                }
            }),
            "tools/call" => {
                let cwd = req
                    .pointer("/params/arguments/cwd")
                    .and_then(Value::as_str)
                    .unwrap_or(".")
                    .to_string();
                let session_id = req
                    .pointer("/params/arguments/sessionId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                match send_request(
                    endpoint,
                    &IpcRequest::HookPrompt {
                        client: "mcp".into(),
                        cwd,
                        session_id,
                    },
                ) {
                    Ok(IpcResponse::HookReply { summary, .. }) => json!({
                        "jsonrpc": "2.0",
                        "id": reply_id,
                        "result": {
                            "content": [{ "type": "text", "text": summary }]
                        }
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
    fn extracts_cli_flags_cleanly() {
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
    }
}
