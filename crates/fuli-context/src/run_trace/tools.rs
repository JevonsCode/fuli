//! Per-tool tracers: what one MCP tool's result means, as run-log steps.
//!
//! Add a tool (or change how one reads) by adding a `ToolTracer` to `registry()`.
//! Nothing else in the run log needs to change.

use serde_json::Value;

use super::{Builder, arr, n, push_delivery, push_resolution, s, titles};

pub trait ToolTracer: Sync {
    /// MCP tool name this tracer describes.
    fn tool(&self) -> &'static str;
    /// Add steps between the core's `trigger` and `return` steps.
    fn trace(&self, args: &Value, out: &Value, b: &mut Builder);
}

pub(super) fn registry() -> &'static [&'static dyn ToolTracer] {
    &[
        &SearchKnowledge,
        &ResolveContext,
        &SaveRule,
        &Checkpoint,
        &ProposeKnowledge,
    ]
}

struct SearchKnowledge;
impl ToolTracer for SearchKnowledge {
    fn tool(&self) -> &'static str {
        "search_knowledge"
    }
    fn trace(&self, _args: &Value, out: &Value, b: &mut Builder) {
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
}

struct ResolveContext;
impl ToolTracer for ResolveContext {
    fn tool(&self) -> &'static str {
        "resolve_context"
    }
    fn trace(&self, args: &Value, out: &Value, b: &mut Builder) {
        b.turn_seq = n(out, "/turn_seq");
        push_resolution(b, out, s(args, "/cwd"));
        push_delivery(b, out);
    }
}

struct SaveRule;
impl ToolTracer for SaveRule {
    fn tool(&self) -> &'static str {
        "save_rule_or_preference"
    }
    fn trace(&self, _args: &Value, out: &Value, b: &mut Builder) {
        b.push(
            "write",
            format!("保存规矩：{}", s(out, "/rule/pref_key")),
            format!("状态 {}", s(out, "/rule/status")),
            0,
        );
    }
}

struct Checkpoint;
impl ToolTracer for Checkpoint {
    fn tool(&self) -> &'static str {
        "checkpoint_workstream"
    }
    fn trace(&self, _args: &Value, out: &Value, b: &mut Builder) {
        b.push(
            "write",
            format!("记录工作线进度：{}", s(out, "/checkpoint/goal")),
            "",
            0,
        );
    }
}

struct ProposeKnowledge;
impl ToolTracer for ProposeKnowledge {
    fn tool(&self) -> &'static str {
        "propose_knowledge"
    }
    fn trace(&self, _args: &Value, out: &Value, b: &mut Builder) {
        b.push("write", "提交一条知识", s(out, "/item/title"), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_tool_has_one_tracer() {
        let mut names: Vec<_> = registry().iter().map(|t| t.tool()).collect();
        let n = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), n, "duplicate tracer registration");
    }
}
