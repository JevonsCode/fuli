use std::process::Command;

use fuli_domain::{RoundtableExchange, WakeStatus};
use fuli_store::{FuliStore, StoreResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeWakeCommand {
    pub program: String,
    pub args: Vec<String>,
    pub display_cli: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskAgentInput {
    pub agent_id: Option<String>,
    pub from_client: String,
    pub from_session_id: String,
    pub to_client: String,
    pub to_session_id: String,
    pub question: String,
    /// When true, attempts read-only local CLI resume (`claude --resume ... --fork-session -p`
    /// or `codex resume ...`). Falls back cleanly to `QueuedInbox` if unavailable.
    pub attempt_native_wake: bool,
}

/// Build the exact read-only native wake command for supported AI coding clients.
/// Uses the client's real `session_id` without any LAN discovery or heavyweight broker.
pub fn build_native_wake_command(
    to_client: &str,
    to_session_id: &str,
    question: &str,
) -> Option<NativeWakeCommand> {
    let prompt = format!(
        "[FULI 圆桌只读问询] 请仅基于你当前会话上下文简明回答以下问题，不要修改文件：\n{question}"
    );
    match to_client.to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => {
            let args = vec![
                "--resume".to_string(),
                to_session_id.to_string(),
                "--fork-session".to_string(),
                "-p".to_string(),
                prompt,
            ];
            Some(NativeWakeCommand {
                program: "claude".into(),
                display_cli: format!("claude --resume {to_session_id} --fork-session -p \"...\""),
                args,
            })
        }
        "codex" => {
            let args = vec![
                "exec".to_string(),
                "resume".to_string(),
                to_session_id.to_string(),
                prompt,
            ];
            Some(NativeWakeCommand {
                program: "codex".into(),
                display_cli: format!("codex exec resume {to_session_id} \"...\""),
                args,
            })
        }
        _ => None,
    }
}

/// Ask another active/recent client session a question via FULI Roundtable.
/// Never fakes a wake reply: either genuinely invokes the native CLI or queues to inbox.
pub fn ask_agent(store: &FuliStore, input: &AskAgentInput) -> StoreResult<RoundtableExchange> {
    let mut answer: Option<String> = None;
    let mut wake_status = WakeStatus::QueuedInbox;

    if input.attempt_native_wake
        && let Some(cmd) =
            build_native_wake_command(&input.to_client, &input.to_session_id, &input.question)
    {
        match Command::new(&cmd.program).args(&cmd.args).output() {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !text.is_empty() {
                    answer = Some(text);
                    wake_status = WakeStatus::WokenReplied;
                }
            }
            _ => {
                // Honest fallback: keep queued in inbox so target picks it up on next turn.
                wake_status = WakeStatus::QueuedInbox;
            }
        }
    }

    store.insert_roundtable_exchange(
        input.agent_id.as_deref(),
        &input.from_client,
        &input.from_session_id,
        &input.to_client,
        &input.to_session_id,
        &input.question,
        answer.as_deref(),
        wake_status,
    )
}

pub fn check_inbox(
    store: &FuliStore,
    client: Option<&str>,
    session_id: Option<&str>,
    only_pending: bool,
) -> StoreResult<Vec<RoundtableExchange>> {
    store.list_roundtable_exchanges(client, session_id, only_pending, 20)
}

pub fn reply_inbox(store: &FuliStore, exchange_id: &str, answer: &str) -> StoreResult<()> {
    store.answer_roundtable_exchange(exchange_id, answer, WakeStatus::WokenReplied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_native_resume_commands_for_claude_code_and_codex() {
        let claude = build_native_wake_command("claude-code", "sess-c1", "刚才为什么改了端口？")
            .expect("claude cmd");
        assert_eq!(claude.program, "claude");
        assert!(claude.args.contains(&"--resume".to_string()));
        assert!(claude.args.contains(&"--fork-session".to_string()));
        assert!(claude.args.contains(&"sess-c1".to_string()));

        let codex =
            build_native_wake_command("codex", "sess-x2", "单测通过了吗？").expect("codex cmd");
        assert_eq!(codex.program, "codex");
        assert!(codex.args.contains(&"sess-x2".to_string()));

        assert!(build_native_wake_command("unknown-ide", "s1", "hi").is_none());
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
                attempt_native_wake: false,
            },
        )
        .unwrap();
        assert_eq!(ex.wake_status, WakeStatus::QueuedInbox);

        let inbox = check_inbox(&store, Some("claude-code"), Some("sess-b"), true).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].id, ex.id);

        reply_inbox(&store, &ex.id, "确认完了，17 张表全部就绪。").unwrap();
        let pending = check_inbox(&store, Some("claude-code"), Some("sess-b"), true).unwrap();
        assert!(pending.is_empty());
        let all = check_inbox(&store, Some("claude-code"), Some("sess-b"), false).unwrap();
        assert_eq!(
            all[0].answer.as_deref(),
            Some("确认完了，17 张表全部就绪。")
        );
    }
}
