//! 运行日志：每次对话里 FULI 做了哪几步（Hook / MCP），每步一个 tag。
//!
//! Left: recent sessions. Right: the selected session as a timeline, one group per
//! Hook event or MCP call, each step a coloured tag + one-line title + short detail.

use std::collections::HashSet;

use fuli_ui_kit::{
    BadgeTone, TimelineEntry, colors, empty_state, fuli_icon, fuli_timeline, layout, section_card,
    section_header, typography,
};
use gpui_kit::*;
use serde::Deserialize;
use serde_json::json;

use super::{FuliAppView, tr};

#[derive(Debug, Clone, Deserialize)]
pub struct RunSessionRow {
    pub client_id: String,
    pub session_id: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub traces: i64,
    pub steps: i64,
    pub tokens_est: i64,
    pub last_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RunStepRow {
    pub trace_id: String,
    pub source: String,
    pub tag: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    pub duration_us: i64,
    pub tokens_est: i64,
    pub created_at: String,
}

#[derive(Default)]
pub struct RunLogState {
    pub sessions: Vec<RunSessionRow>,
    pub selected: Option<(String, String)>,
    pub steps: Vec<RunStepRow>,
    /// Indices of expanded traces (newest one opens by default).
    pub expanded: HashSet<usize>,
    pub error: Option<String>,
}

/// Plain-language tag label + chip colours (bg, fg). Colours come from kit tokens.
fn tag_style(tag: &str) -> (&'static str, Rgba, Rgba) {
    match tag {
        "trigger" => ("触发", colors::ink(), colors::surface()),
        "project" => ("项目", colors::gold_soft(), colors::gold()),
        "rules" => ("规矩", colors::warning_bg(), colors::warning()),
        "inbox" => ("圆桌", colors::warning_bg(), colors::warning()),
        "workstream" => ("工作线", colors::subtle(), colors::ink()),
        "dedup" => ("去重", colors::subtle(), colors::muted()),
        "skip" => ("跳过", colors::subtle(), colors::muted()),
        "search" => ("检索", colors::success_bg(), colors::success()),
        "hit" => ("命中", colors::success_bg(), colors::success()),
        "miss" => ("未命中", colors::subtle(), colors::muted()),
        "write" => ("写入", colors::gold_soft(), colors::gold()),
        "epoch" => ("纪元", colors::gold_soft(), colors::gold()),
        "error" => ("出错", colors::danger_bg(), colors::danger()),
        "return" => ("返回", colors::subtle(), colors::ink()),
        _ => ("步骤", colors::subtle(), colors::muted()),
    }
}

fn tag_chip_colored(tag: &str) -> Div {
    let (label, bg, fg) = tag_style(tag);
    div()
        .flex_shrink_0()
        .w(px(52.0))
        .h(px(20.0))
        .rounded(layout::radius_pill())
        .bg(bg)
        .text_color(fg)
        .text_size(typography::meta_size())
        .font_weight(FontWeight::SEMIBOLD)
        .flex()
        .items_center()
        .justify_center()
        .child(label)
}

fn short_time(ts: &str) -> String {
    ts.get(11..19).unwrap_or(ts).to_string()
}

/// Tone for the one-line trace summary: errors first, then hits, misses, deliveries.
fn trace_tone(steps: &[&RunStepRow]) -> BadgeTone {
    let has = |t: &str| steps.iter().any(|s| s.tag == t);
    if has("error") {
        BadgeTone::Danger
    } else if has("hit") || has("write") {
        BadgeTone::Success
    } else if has("miss") || has("skip") {
        BadgeTone::Neutral
    } else if steps.first().is_some_and(|s| s.source == "hook") {
        BadgeTone::Gold
    } else {
        BadgeTone::Warning
    }
}

/// "识别到 Saturn · 命中 5 条 · 返回 ~1332 tok" — the steps that matter, in order.
fn trace_summary(steps: &[&RunStepRow]) -> String {
    steps
        .iter()
        .skip(1)
        .filter(|s| !matches!(s.tag.as_str(), "dedup" | "workstream"))
        .map(|s| s.title.clone())
        .collect::<Vec<_>>()
        .join(" · ")
}

impl RunLogState {
    fn trace_count(&self) -> usize {
        let mut n = 0;
        let mut last = "";
        for st in &self.steps {
            if st.trace_id != last {
                n += 1;
                last = &st.trace_id;
            }
        }
        n
    }

    pub fn load(endpoint: &str) -> Self {
        let mut st = Self::default();
        match crate::state::dispatch_ui_action(endpoint, "run_sessions", json!({ "limit": 40 })) {
            Ok(v) => {
                st.sessions = serde_json::from_value(v["sessions"].clone()).unwrap_or_default();
            }
            Err(e) => st.error = Some(e),
        }
        if let Some(first) = st.sessions.first() {
            let key = (first.client_id.clone(), first.session_id.clone());
            st.select(endpoint, key);
        }
        st
    }

    pub fn select(&mut self, endpoint: &str, key: (String, String)) {
        match crate::state::dispatch_ui_action(
            endpoint,
            "run_steps",
            json!({ "client": key.0, "session": key.1 }),
        ) {
            Ok(v) => {
                self.steps = serde_json::from_value(v["steps"].clone()).unwrap_or_default();
                self.error = None;
                self.expanded.clear();
                let traces = self.trace_count();
                if traces > 0 {
                    self.expanded.insert(traces - 1);
                }
            }
            Err(e) => self.error = Some(e),
        }
        self.selected = Some(key);
    }
}

impl FuliAppView {
    pub(crate) fn render_run_log(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let log = &self.run_log;

        let mut list = div().flex().flex_col().gap(px(6.0));
        if log.sessions.is_empty() {
            list = list.child(empty_state(
                tr(l, "还没有运行记录", "No runs yet"),
                tr(
                    l,
                    "在 Claude Code / Codex 里聊一句，FULI 每一步都会记在这里。",
                    "Chat once in Claude Code or Codex; every FULI step shows up here.",
                ),
            ));
        }
        for (i, s) in log.sessions.iter().enumerate() {
            let key = (s.client_id.clone(), s.session_id.clone());
            let active = log.selected.as_ref() == Some(&key);
            let project = s
                .agent_name
                .clone()
                .unwrap_or_else(|| tr(l, "未绑定项目", "No project").to_string());
            let row = div()
                .id(("run-session", i))
                .w_full()
                .px(px(12.0))
                .py(px(10.0))
                .rounded(layout::radius_control())
                .border_1()
                .border_color(if active {
                    colors::ink()
                } else {
                    colors::border()
                })
                .bg(if active {
                    colors::surface()
                } else {
                    colors::canvas()
                })
                .hover(|st| st.bg(colors::hover()))
                .cursor_pointer()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(typography::body_size())
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::ink())
                                .child(project),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(short_time(&s.last_at)),
                        ),
                )
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(format!(
                            "{} · {} · {} 次 · {} 步 · ~{} tok",
                            s.client_id,
                            s.session_id.chars().take(8).collect::<String>(),
                            s.traces,
                            s.steps,
                            s.tokens_est
                        )),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_log.select(&this.endpoint, key.clone());
                    cx.notify();
                }));
            list = list.child(row);
        }

        // Right: one timeline entry per trace (one Hook event / one MCP call); expanding
        // it shows every step with its tag.
        let mut groups: Vec<(String, Vec<&RunStepRow>)> = Vec::new();
        for st in &log.steps {
            match groups.last_mut() {
                Some((id, v)) if *id == st.trace_id => v.push(st),
                _ => groups.push((st.trace_id.clone(), vec![st])),
            }
        }
        let mut entries = Vec::new();
        for (gi, (_, steps)) in groups.iter().enumerate() {
            let head = steps[0];
            let tokens: i64 = steps.iter().map(|s| s.tokens_est).sum();
            let mut detail = div().flex().flex_col().gap(px(8.0)).pt(px(4.0));
            for st in steps.iter().skip(1) {
                let mut text = div().flex().flex_col().gap(px(2.0)).min_w(px(0.0)).child(
                    div()
                        .text_size(typography::body_size())
                        .text_color(colors::ink())
                        .child(st.title.clone()),
                );
                if !st.detail.is_empty() {
                    text = text.child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(st.detail.clone()),
                    );
                }
                detail = detail.child(
                    div()
                        .flex()
                        .gap(px(10.0))
                        .items_start()
                        .child(tag_chip_colored(&st.tag))
                        .child(text),
                );
            }
            let source = if head.source == "hook" { "Hook" } else { "MCP" };
            let summary = trace_summary(steps);
            let mut entry = TimelineEntry::new(source, trace_tone(steps), head.title.clone())
                .time(short_time(&head.created_at))
                .duration(format!(
                    "{:.2} ms · ~{tokens} tok",
                    head.duration_us as f64 / 1000.0
                ))
                .detail(detail.into_any_element())
                .expanded(log.expanded.contains(&gi));
            if !summary.is_empty() {
                entry = entry.subtitle(summary);
            }
            entries.push(entry);
        }
        let timeline = if groups.is_empty() {
            div().child(empty_state(
                tr(l, "这个会话没有步骤", "No steps in this session"),
                "",
            ))
        } else {
            div().child(fuli_timeline(
                "run-timeline-list",
                entries,
                cx.listener(|this, idx: &usize, _, cx| {
                    if !this.run_log.expanded.remove(idx) {
                        this.run_log.expanded.insert(*idx);
                    }
                    cx.notify();
                }),
            ))
        };

        let header = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .mb(px(12.0))
            .child(section_header(tr(l, "运行日志", "Run Log"), None))
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(tr(
                        l,
                        "每次对话里 FULI 做了什么：从哪儿触发、认出哪个项目、找到哪些知识、返回了多少。",
                        "What FULI did each turn: trigger, project, knowledge found, what it returned.",
                    )),
            );

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(16.0))
            .child(
                div()
                    .w(px(300.0))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(fuli_icon("list-clock", 16.0, colors::ink()))
                            .child(
                                div()
                                    .text_size(typography::section_size())
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(tr(l, "最近会话", "Recent sessions")),
                            ),
                    )
                    .child(
                        div()
                            .id("run-session-list")
                            .flex_1()
                            .min_h(px(0.0))
                            .overflow_y_scroll()
                            .child(list),
                    ),
            )
            .child(
                div()
                    .id("run-timeline")
                    .flex_1()
                    .min_w(px(0.0))
                    .overflow_y_scroll()
                    .child(section_card().child(header).child(timeline)),
            )
    }
}
