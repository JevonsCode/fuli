//! Turns one Hook event or MCP tool call into run-log steps.
//!
//! Steps are derived from the result FULI already computed (no extra queries), and only
//! carry counts, IDs and short titles. Recording never fails the request it describes.

use fuli_domain::{new_id, now_rfc3339};
use fuli_store::{FuliStore, RunStep};
use serde_json::Value;

struct Builder {
    client: String,
    session: String,
    source: &'static str,
    trace_id: String,
    turn_seq: i64,
    agent_id: Option<String>,
    started_at: String,
    steps: Vec<RunStep>,
}

impl Builder {
    fn new(client: &str, session: &str, source: &'static str) -> Self {
        Self {
            client: client.to_string(),
            session: session.to_string(),
            source,
            trace_id: new_id(),
            turn_seq: 0,
            agent_id: None,
            started_at: now_rfc3339(),
            steps: Vec::new(),
        }
    }

    fn push(
        &mut self,
        tag: &str,
        title: impl Into<String>,
        detail: impl Into<String>,
        tokens: i64,
    ) {
        let seq = self.steps.len() as i64 + 1;
        self.steps.push(RunStep {
            id: new_id(),
            client_id: self.client.clone(),
            session_id: self.session.clone(),
            turn_seq: self.turn_seq,
            trace_id: self.trace_id.clone(),
            step_seq: seq,
            source: self.source.to_string(),
            tag: tag.to_string(),
            title: title.into(),
            detail: detail.into(),
            agent_id: self.agent_id.clone(),
            duration_us: 0,
            tokens_est: tokens,
            // One timestamp per trace keeps a trace's steps together when listed.
            created_at: self.started_at.clone(),
        });
    }

    fn finish(mut self, store: &FuliStore, total_us: u64) {
        // Total time sits on the first step; per-step timing would need instrumenting the
        // kernel, which the log must not slow down.
        if let Some(first) = self.steps.first_mut() {
            first.duration_us = total_us as i64;
        }
        for st in &mut self.steps {
            st.agent_id = self.agent_id.clone();
        }
        if let Err(err) = store.insert_run_steps(&self.steps) {
            eprintln!("fuli-context run log write skipped: {err}");
        }
    }
}

fn s<'a>(v: &'a Value, ptr: &str) -> &'a str {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("")
}

fn n(v: &Value, ptr: &str) -> i64 {
    v.pointer(ptr).and_then(Value::as_i64).unwrap_or(0)
}

fn arr<'a>(v: &'a Value, ptr: &str) -> &'a [Value] {
    v.pointer(ptr)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn titles(items: &[Value], key: &str, max: usize) -> String {
    items
        .iter()
        .take(max)
        .filter_map(|i| i.get(key).and_then(Value::as_str))
        .map(|t| t.chars().take(40).collect::<String>())
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Project-resolution step shared by Hook and `resolve_context`.
fn push_resolution(b: &mut Builder, packet: &Value, cwd: &str) {
    match s(packet, "/agent_resolution/status") {
        "matched" => {
            b.agent_id = Some(s(packet, "/agent_resolution/agent/id").to_string());
            b.push(
                "project",
                format!("识别到项目：{}", s(packet, "/agent_resolution/agent/name")),
                format!("依据 {} · 目录 {cwd}", s(packet, "/agent_resolution/basis")),
                0,
            );
        }
        "ambiguous" => b.push(
            "project",
            format!(
                "项目不确定：{} 个候选",
                arr(packet, "/agent_resolution/candidates").len()
            ),
            format!("目录 {cwd}"),
            0,
        ),
        _ => b.push("project", "没有绑定项目", format!("目录 {cwd}"), 0),
    }
}

fn push_delivery(b: &mut Builder, packet: &Value) {
    let rules = arr(packet, "/hard_rules");
    let prefs = arr(packet, "/preferences");
    if !rules.is_empty() || !prefs.is_empty() {
        b.push(
            "rules",
            format!("下发红线 {} 条、习惯 {} 条", rules.len(), prefs.len()),
            titles(&[rules, prefs].concat(), "pref_key", 6),
            n(packet, "/tokens_sent_est"),
        );
    }
    let dedup = n(packet, "/dedup_skipped_count");
    if dedup > 0 {
        b.push(
            "dedup",
            format!("跳过 {dedup} 条本会话已有的内容"),
            format!("约省 {} tokens", n(packet, "/tokens_saved_est")),
            0,
        );
    }
    let inbox = arr(packet, "/pending_inbox");
    if !inbox.is_empty() {
        b.push(
            "inbox",
            format!("捎带圆桌待回复 {} 条", inbox.len()),
            titles(inbox, "question", 3),
            0,
        );
    }
    let ws = arr(packet, "/open_workstreams");
    if !ws.is_empty() {
        b.push(
            "workstream",
            format!("进行中的工作线 {} 条", ws.len()),
            titles(ws, "title", 3),
            0,
        );
    }
}

pub fn record_hook(
    store: &FuliStore,
    client: &str,
    session: Option<&str>,
    event: &str,
    cwd: &str,
    packet: &Value,
    total_us: u64,
) {
    let session = session.unwrap_or("default");
    let mut b = Builder::new(client, session, "hook");
    b.turn_seq = n(packet, "/turn_seq");
    match event {
        "pre_compact" | "compact" => {
            b.push("trigger", "上下文压缩前 (PreCompact)", "", 0);
            b.push(
                "epoch",
                format!(
                    "开启新纪元 {}，下轮重新注入规矩",
                    n(packet, "/context_epoch")
                ),
                "",
                0,
            );
        }
        "stop" => {
            b.push("trigger", "本轮结束 (Stop)", "", 0);
            let inbox = arr(packet, "/pending_inbox");
            if !inbox.is_empty() {
                b.push("inbox", format!("圆桌待回复 {} 条", inbox.len()), "", 0);
            }
        }
        _ => {
            b.push(
                "trigger",
                "用户发了一条消息 (UserPromptSubmit)",
                format!(
                    "第 {} 轮 · 纪元 {}",
                    b.turn_seq,
                    n(packet, "/context_epoch")
                ),
                0,
            );
            if s(packet, "/control_mode") == "disabled" {
                b.push("skip", "这个会话关闭了 FULI，什么也没注入", "", 0);
            } else {
                push_resolution(&mut b, packet, cwd);
                push_delivery(&mut b, packet);
                let tokens = n(packet, "/tokens_sent_est");
                if tokens > 0 {
                    b.push(
                        "return",
                        format!("注入给模型，约 {tokens} tokens"),
                        "",
                        tokens,
                    );
                } else {
                    b.push("return", "没有新内容需要注入", "", 0);
                }
            }
        }
    }
    b.finish(store, total_us);
}

fn arg_summary(args: &Value) -> String {
    let mut parts = Vec::new();
    for key in ["query", "cwd", "title", "prefKey", "goal", "toClient", "op"] {
        if let Some(v) = args
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            parts.push(format!("{key}={}", v.chars().take(60).collect::<String>()));
        }
    }
    parts.join(" · ")
}

pub fn record_tool(
    store: &FuliStore,
    client: &str,
    session: &str,
    tool: &str,
    args: &Value,
    result: Result<&Value, &str>,
    total_us: u64,
) {
    let mut b = Builder::new(client, session, "mcp");
    // Tool results don't name the project; attribute the call by the cwd it passed.
    if let Some(cwd) = args
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        && let Ok((fuli_domain::AgentResolution::Matched { agent, .. }, _)) =
            store.resolve_agent_by_cwd(cwd)
    {
        b.agent_id = Some(agent.id);
    }
    b.push(
        "trigger",
        format!("模型调用工具 {tool}"),
        arg_summary(args),
        0,
    );
    let out = match result {
        Ok(v) => v,
        Err(msg) => {
            b.push(
                "error",
                "调用失败",
                msg.chars().take(200).collect::<String>(),
                0,
            );
            return b.finish(store, total_us);
        }
    };
    let bytes = out.to_string().len() as i64;
    let tokens = (bytes + 2) / 3;
    match tool {
        "search_knowledge" => {
            let hits = arr(out, "/hits");
            let kbs: std::collections::BTreeSet<&str> = hits
                .iter()
                .filter_map(|h| h.get("kb_name").and_then(Value::as_str))
                .collect();
            b.push(
                "search",
                format!(
                    "在 {} 个授权知识库里检索「{}」",
                    n(out, "/authorized_kb_count"),
                    s(out, "/query")
                ),
                format!("共匹配 {} 条", n(out, "/budget/total_matched")),
                0,
            );
            if hits.is_empty() {
                b.push("miss", "没有找到相关知识", "", 0);
            } else {
                b.push(
                    "hit",
                    format!(
                        "命中 {} 条（来自 {}）",
                        hits.len(),
                        kbs.into_iter().collect::<Vec<_>>().join("、")
                    ),
                    titles(hits, "title", 3),
                    0,
                );
            }
        }
        "resolve_context" => {
            b.turn_seq = n(out, "/turn_seq");
            push_resolution(&mut b, out, s(args, "/cwd"));
            push_delivery(&mut b, out);
        }
        "save_rule_or_preference" => b.push(
            "write",
            format!("保存规矩：{}", s(out, "/rule/pref_key")),
            format!("状态 {}", s(out, "/rule/status")),
            0,
        ),
        "checkpoint_workstream" => b.push(
            "write",
            format!("记录工作线进度：{}", s(out, "/checkpoint/goal")),
            "",
            0,
        ),
        "propose_knowledge" => b.push("write", "提交一条知识", s(out, "/item/title"), 0),
        _ => {}
    }
    b.push(
        "return",
        format!("返回给模型，约 {tokens} tokens"),
        format!("{bytes} 字节"),
        tokens,
    );
    b.finish(store, total_us);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hook_and_search_traces_read_like_a_story() {
        let store = FuliStore::open_in_memory().unwrap();
        let packet = json!({
            "turn_seq": 2, "context_epoch": 0, "control_mode": "normal",
            "agent_resolution": { "status": "matched", "basis": "git_remote", "agent": { "id": "a1", "name": "FULI" } },
            "hard_rules": [{ "pref_key": "reply.lang" }],
            "dedup_skipped_count": 3, "tokens_sent_est": 12, "tokens_saved_est": 40
        });
        record_hook(
            &store,
            "claude-code",
            Some("s1"),
            "prompt",
            "/w/fuli",
            &packet,
            900,
        );
        let search = json!({
            "query": "活动承接", "authorized_kb_count": 2,
            "budget": { "total_matched": 5 },
            "hits": [{ "title": "排期规则", "kb_name": "Saturn" }]
        });
        record_tool(
            &store,
            "claude-code",
            "s1",
            "search_knowledge",
            &json!({ "query": "活动承接" }),
            Ok(&search),
            1200,
        );

        let steps = store.list_run_steps("claude-code", "s1", 50).unwrap();
        let tags: Vec<&str> = steps.iter().map(|s| s.tag.as_str()).collect();
        assert_eq!(
            tags,
            [
                "trigger", "project", "rules", "dedup", "return", "trigger", "search", "hit",
                "return"
            ]
        );
        assert!(steps[1].title.contains("FULI"));
        assert!(steps[7].title.contains("Saturn") && steps[7].detail.contains("排期规则"));
        assert_eq!(steps[0].duration_us, 900);
        assert!(
            steps
                .iter()
                .take(5)
                .all(|s| s.agent_id.as_deref() == Some("a1"))
        );
        let sessions = store.list_run_sessions(5).unwrap();
        assert_eq!(sessions[0].traces, 2);
    }
}
