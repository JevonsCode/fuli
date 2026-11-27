//! FULI Concierge ("FULI 大管家") Interactive Split Workspace.
//!
//! Single-entry commander inspired by Codex Dot:
//! - Left stage: Living animated FULI Orb + unified command bar + transparent Route Preview card
//!   (auto-detected FULI Bot, 1-click correction pills, seamless client switching with cross-client
//!   Handoff Brief preview, resolved repo `working_dir`, CLI availability, explicit Read-Only vs
//!   Workspace-Write safety toggle, latest `session_id` reuse) + durable conversation & correction feed.
//! - Right stage: Friendly live Running Tasks stack + All-Bot Session Memory Radar with 1-click
//!   "Sync Local Sessions", "Resume Latest Session", "Switch Client", and "Copy Resume CLI".

use std::time::Duration;

use fuli_ui_kit::{
    AvatarPresence, AvatarSize, BadgeTone, ControlSize, Locale, OrbState, apple_stagger_card,
    colors, empty_state, fuli_avatar, fuli_concierge_orb, fuli_icon, ghost_button, inset_panel,
    layout, orb_mini_indicator, primary_button, progress_bar_animated, scroll_area,
    secondary_button, section_card, section_header, spring_entrance, spring_segment_slot,
    spring_segmented_control, status_badge, tag_chip, text_input, typography,
};
use gpui_kit::*;
use serde_json::json;

use crate::state::{ConciergeRoutePreviewData, dispatch_ui_action, session_resume_command};
use crate::{ConciergeSubTab, FuliAppView, tr};

fn client_label(client: &str) -> &'static str {
    match client.to_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => "Claude Code",
        "codex" => "Codex",
        "opencode" | "open-code" | "open_code" => "OpenCode",
        "cursor" => "Cursor",
        "fuli-concierge" => "FULI 大管家",
        _ => "AI 客户端",
    }
}

fn short_sess(sid: &str) -> String {
    let s = sid.trim();
    if s.is_empty() || s == "*" || s == "default" {
        "新会话 / 自动匹配".to_string()
    } else if s.chars().count() <= 12 {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(10).collect::<String>())
    }
}

fn mode_label(l: Locale, mode: &str) -> &'static str {
    match mode {
        "memory_answer" => tr(l, "0 Token 记忆直答", "0-Token Memory Answer"),
        "resume_latest_session" => tr(l, "续跑最近会话", "Resume Latest Session"),
        "switch_client_handoff" => tr(l, "跨客户端接力", "Cross-Client Handoff"),
        _ => tr(l, "投递收件箱（下轮捎带）", "Inbox Piggyback"),
    }
}

fn pick_alternate_client(current: &str) -> &'static str {
    match current.to_lowercase().as_str() {
        "claude-code" | "claude" => "codex",
        "codex" => "claude-code",
        "opencode" => "claude-code",
        _ => "claude-code",
    }
}

impl FuliAppView {
    pub(crate) fn running_concierge_count(&self) -> usize {
        self.status
            .data
            .concierge_tasks
            .iter()
            .filter(|t| t.status == "running" || t.status == "queued")
            .count()
    }

    pub(crate) fn request_concierge_preview(&mut self, cx: &mut Context<Self>) {
        let prompt = self.concierge_input.read(cx).value().trim().to_string();
        if prompt.is_empty() {
            let msg = tr(
                self.locale(),
                "先跟大管家说一句话，比如「看看所有项目最近在干嘛」",
                "Tell the Concierge what you want to do first",
            );
            self.push_toast(msg, BadgeTone::Warning, cx);
            return;
        }
        let mut payload = json!({
            "prompt": prompt,
            "allow_write": self.concierge_allow_write,
        });
        if let Some(ref aid) = self.concierge_override_agent_id {
            payload["override_agent_id"] = json!(aid);
        }
        if let Some(ref cli) = self.concierge_override_client {
            payload["override_client"] = json!(cli);
        }
        if let Some(ref sid) = self.concierge_override_session_id {
            payload["override_session_id"] = json!(sid);
        }
        if let Some(ref mode) = self.concierge_override_mode {
            payload["override_mode"] = json!(mode);
        }

        match dispatch_ui_action(&self.endpoint, "concierge_preview", payload) {
            Ok(val) => match serde_json::from_value::<ConciergeRoutePreviewData>(val) {
                Ok(preview) => {
                    self.concierge_preview = Some(preview);
                    cx.notify();
                }
                Err(err) => {
                    self.push_toast(format!("解析路由预览失败：{err}"), BadgeTone::Danger, cx);
                }
            },
            Err(err) => {
                self.push_toast(format!("路由预览失败：{err}"), BadgeTone::Danger, cx);
            }
        }
    }

    pub(crate) fn dispatch_concierge_now(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let prompt = self
            .concierge_preview
            .as_ref()
            .map(|p| p.prompt.clone())
            .unwrap_or_else(|| self.concierge_input.read(cx).value().trim().to_string());
        if prompt.is_empty() {
            let msg = tr(
                self.locale(),
                "先输入指令再派发给大管家",
                "Enter a request before dispatching",
            );
            self.push_toast(msg, BadgeTone::Warning, cx);
            return;
        }

        let mut payload = json!({
            "prompt": prompt,
            "was_corrected": self.concierge_was_corrected,
            "allow_write": self.concierge_allow_write,
        });
        if let Some(ref aid) = self.concierge_override_agent_id {
            payload["override_agent_id"] = json!(aid);
        }
        if let Some(ref cli) = self.concierge_override_client {
            payload["override_client"] = json!(cli);
        }
        if let Some(ref sid) = self.concierge_override_session_id {
            payload["override_session_id"] = json!(sid);
        }
        if let Some(ref mode) = self.concierge_override_mode {
            payload["override_mode"] = json!(mode);
        }

        match dispatch_ui_action(&self.endpoint, "concierge_dispatch", payload) {
            Ok(val) => {
                let is_async = val.get("async").and_then(|v| v.as_bool()).unwrap_or(false);
                self.concierge_input
                    .update(cx, |s, cx| s.set_value("", window, cx));
                self.concierge_preview = None;
                self.concierge_override_agent_id = None;
                self.concierge_override_client = None;
                self.concierge_override_session_id = None;
                self.concierge_override_mode = None;
                self.concierge_allow_write = false;
                self.concierge_was_corrected = false;
                self.refresh(cx);
                let msg = if is_async {
                    tr(
                        self.locale(),
                        "大管家已派发到后台执行，右侧可实时查看进度",
                        "Dispatched live — watch progress in Running Tasks",
                    )
                } else {
                    tr(self.locale(), "大管家已完成处理", "Concierge completed")
                };
                self.push_toast(msg, BadgeTone::Success, cx);
                if is_async || self.running_concierge_count() > 0 {
                    self.ensure_concierge_polling(cx);
                }
            }
            Err(err) => {
                self.push_toast(format!("派发失败：{err}"), BadgeTone::Danger, cx);
            }
        }
    }

    pub(crate) fn sync_local_sessions_now(&mut self, cx: &mut Context<Self>) {
        match dispatch_ui_action(
            &self.endpoint,
            "sync_local_sessions",
            json!({ "limit": 40 }),
        ) {
            Ok(val) => {
                let scanned = val["scanned"].as_u64().unwrap_or(0);
                let imported = val["imported"].as_u64().unwrap_or(0);
                let matched = val["matched_bots"].as_u64().unwrap_or(0);
                self.refresh(cx);
                let msg = if self.locale() == Locale::ZhCn {
                    format!(
                        "已扫描本机 {scanned} 条会话 · 新导入 {imported} 条 · 自动归属 {matched} 条"
                    )
                } else {
                    format!(
                        "Scanned {scanned} local sessions · {imported} imported · {matched} matched"
                    )
                };
                self.push_toast(msg, BadgeTone::Success, cx);
            }
            Err(err) => {
                self.push_toast(format!("扫描本地会话失败：{err}"), BadgeTone::Danger, cx);
            }
        }
    }

    pub(crate) fn ensure_concierge_polling(&mut self, cx: &mut Context<Self>) {
        if self.concierge_polling_active {
            return;
        }
        self.concierge_polling_active = true;
        cx.spawn(async move |this, cx| {
            for _ in 0..90 {
                cx.background_executor()
                    .timer(Duration::from_millis(450))
                    .await;
                let keep_going = this
                    .update(cx, |view, cx| {
                        view.refresh(cx);
                        let active = view.running_concierge_count() > 0;
                        if !active {
                            view.concierge_polling_active = false;
                        }
                        active
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
            let _ = this.update(cx, |view, _| {
                view.concierge_polling_active = false;
            });
        })
        .detach();
    }

    pub(crate) fn prefill_concierge_prompt(
        &mut self,
        prompt: &str,
        override_agent: Option<String>,
        override_client: Option<String>,
        override_session: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.concierge_override_agent_id = override_agent;
        self.concierge_override_client = override_client;
        self.concierge_override_session_id = override_session;
        self.concierge_override_mode = None;
        self.concierge_was_corrected = false;
        self.concierge_input
            .update(cx, |s, cx| s.set_value(prompt, window, cx));
        self.request_concierge_preview(cx);
    }

    pub(crate) fn render_concierge_or_inbox(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let unread_inbox = self
            .status
            .data
            .roundtable
            .iter()
            .filter(|e| e.wake_status == fuli_domain::WakeStatus::QueuedInbox)
            .count();

        let sub_idx = match self.concierge_sub {
            ConciergeSubTab::Commander => 0,
            ConciergeSubTab::Inbox => 1,
        };
        let inbox_label = if unread_inbox > 0 {
            if l == Locale::ZhCn {
                format!("圆桌信箱 ({unread_inbox})")
            } else {
                format!("Inbox ({unread_inbox})")
            }
        } else {
            tr(l, "圆桌信箱", "Roundtable Inbox").to_string()
        };

        let header_bar = div()
            .flex()
            .items_center()
            .justify_between()
            .mb(px(12.0))
            .child(spring_segmented_control(
                "concierge-sub-spring",
                sub_idx,
                132.0,
                vec![
                    spring_segment_slot(
                        "concierge-tab-main",
                        tr(l, "FULI 大管家", "FULI Concierge"),
                        132.0,
                        self.concierge_sub == ConciergeSubTab::Commander,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.concierge_sub = ConciergeSubTab::Commander;
                        cx.notify();
                    }))
                    .into_any_element(),
                    spring_segment_slot(
                        "concierge-tab-inbox",
                        inbox_label,
                        132.0,
                        self.concierge_sub == ConciergeSubTab::Inbox,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.concierge_sub = ConciergeSubTab::Inbox;
                        cx.notify();
                    }))
                    .into_any_element(),
                ],
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(tag_chip(format!(
                        "{} {}",
                        self.status.data.bot_session_ledgers.len(),
                        tr(l, "个 FULI Bot", "FULI Bots")
                    )))
                    .child(tag_chip(format!(
                        "{} {}",
                        self.status.data.sessions.len(),
                        tr(l, "条已记会话", "Sessions")
                    ))),
            );

        if self.concierge_sub == ConciergeSubTab::Inbox {
            return div()
                .flex_1()
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .child(header_bar)
                .child(self.render_roundtable(cx));
        }

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .child(header_bar)
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .gap(px(16.0))
                    .child(self.render_concierge_main_stage(cx))
                    .child(self.render_concierge_task_sidebar(cx)),
            )
    }

    fn render_concierge_main_stage(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let running = self.running_concierge_count();

        let orb_state = if running > 0 {
            OrbState::Running
        } else if self.concierge_preview.is_some() {
            OrbState::Attention
        } else {
            OrbState::Idle
        };

        let status_headline = if running > 0 {
            if l == Locale::ZhCn {
                format!("正在协同执行 {running} 项任务，完成后自动汇报")
            } else {
                format!("Orchestrating {running} live task(s)...")
            }
        } else if self.concierge_preview.is_some() {
            tr(
                l,
                "已为你规划好项目、工作目录与会话，确认无误即可派发（错了点一下就能改）",
                "Route ready — confirm or click any Bot / Client pill to adjust",
            )
            .to_string()
        } else if l == Locale::ZhCn {
            format!(
                "只跟我说话就行 · 我记着 {} 个 FULI Bot 和 {} 条会话上下文",
                data.bot_session_ledgers.len(),
                data.sessions.len()
            )
        } else {
            format!(
                "One calm entry point across {} FULI Bots & {} remembered sessions",
                data.bot_session_ledgers.len(),
                data.sessions.len()
            )
        };

        let hero_header = div()
            .flex()
            .items_center()
            .gap(px(16.0))
            .child(fuli_concierge_orb("concierge-hero-orb", orb_state, 74.0))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(17.0))
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .child(tr(l, "FULI 大管家", "FULI Concierge")),
                            )
                            .child(status_badge(
                                if running > 0 {
                                    tr(l, "执行中", "Running")
                                } else if self.concierge_preview.is_some() {
                                    tr(l, "待确认分配", "Preview Ready")
                                } else {
                                    tr(l, "随时待命", "Ready")
                                },
                                if running > 0 {
                                    BadgeTone::Warning
                                } else if self.concierge_preview.is_some() {
                                    BadgeTone::Gold
                                } else {
                                    BadgeTone::Success
                                },
                            )),
                    )
                    .child(
                        div()
                            .text_size(typography::body_size())
                            .text_color(colors::muted())
                            .child(status_headline),
                    ),
            );

        let composer_row = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .child(text_input(&self.concierge_input, ControlSize::Lg)),
            )
            .child(
                secondary_button(
                    "btn-concierge-preview",
                    tr(l, "预览分配", "Preview"),
                    ControlSize::Lg,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.concierge_override_agent_id = None;
                    this.concierge_override_client = None;
                    this.concierge_override_session_id = None;
                    this.concierge_override_mode = None;
                    this.concierge_was_corrected = false;
                    this.request_concierge_preview(cx);
                })),
            )
            .child(
                primary_button(
                    "btn-concierge-send",
                    tr(l, "直接派发", "Dispatch"),
                    ControlSize::Lg,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.dispatch_concierge_now(window, cx);
                })),
            );

        let quick_prompts = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .child(
                ghost_button(
                    "qp-overview",
                    tr(l, "✦ 看看所有项目最近在干嘛", "✦ Status of all projects"),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.prefill_concierge_prompt(
                        "看看所有项目最近在干嘛",
                        None,
                        None,
                        None,
                        window,
                        cx,
                    );
                })),
            )
            .child(
                ghost_button(
                    "qp-switch-codex",
                    tr(
                        l,
                        "⇄ 切到 Codex 继续最近项目",
                        "⇄ Switch latest Bot to Codex",
                    ),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    let top_bot = this
                        .status
                        .data
                        .bot_session_ledgers
                        .first()
                        .map(|b| (b.agent_id.clone(), b.agent_name.clone()));
                    let (aid, prompt) = match top_bot {
                        Some((id, name)) => {
                            (Some(id), format!("切到 Codex 继续推进 {name} 的当前工作线"))
                        }
                        None => (None, "切到 Codex 继续最近的工作线".to_string()),
                    };
                    this.prefill_concierge_prompt(
                        &prompt,
                        aid,
                        Some("codex".to_string()),
                        None,
                        window,
                        cx,
                    );
                })),
            )
            .child(
                ghost_button(
                    "qp-resume-claude",
                    tr(
                        l,
                        "↻ 续跑 Claude Code 最近会话",
                        "↻ Resume latest Claude session",
                    ),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    let found = this.status.data.bot_session_ledgers.iter().find_map(|b| {
                        b.recent_sessions
                            .iter()
                            .find(|s| s.client_id.contains("claude"))
                            .map(|s| {
                                (
                                    b.agent_id.clone(),
                                    b.agent_name.clone(),
                                    s.session_id.clone(),
                                )
                            })
                    });
                    match found {
                        Some((aid, name, sid)) => {
                            this.prefill_concierge_prompt(
                                &format!("继续 {name} 上次的进展，先简短汇报当前卡点"),
                                Some(aid),
                                Some("claude-code".to_string()),
                                Some(sid),
                                window,
                                cx,
                            );
                        }
                        None => {
                            this.prefill_concierge_prompt(
                                "检查最近的进展和待办事项",
                                None,
                                Some("claude-code".to_string()),
                                None,
                                window,
                                cx,
                            );
                        }
                    }
                })),
            );

        let mut stage_items = div().flex().flex_col().gap(px(12.0)).pb(px(16.0));
        stage_items = stage_items.child(
            section_card()
                .gap(px(12.0))
                .child(hero_header)
                .child(composer_row)
                .child(quick_prompts),
        );

        if let Some(ref preview) = self.concierge_preview {
            stage_items = stage_items.child(spring_entrance(
                "concierge-preview-card",
                0.0,
                8.0,
                self.render_route_preview_card(preview, cx)
                    .into_any_element(),
            ));
        }

        let mut feed_rows = div().flex().flex_col().gap(px(10.0));
        if data.concierge_tasks.is_empty() {
            feed_rows = feed_rows.child(empty_state(
                tr(l, "大管家对话记录还是空的", "No Concierge dispatches yet"),
                tr(
                    l,
                    "发一句话试一下：你可以直接问全局进度（0 Token 秒答），也可以指定任意项目或一键切换执行客户端。",
                    "Try asking for a global status overview (0 tokens), or route a task to any FULI Bot and switch clients seamlessly.",
                ),
            ));
        } else {
            for (idx, task) in data.concierge_tasks.iter().enumerate() {
                let is_running = task.status == "running" || task.status == "queued";
                let (st_label, st_tone) = match task.status.as_str() {
                    "running" | "queued" => (tr(l, "运行中", "Running"), BadgeTone::Warning),
                    "completed" => (tr(l, "已完成", "Done"), BadgeTone::Success),
                    "needs_attention" => (tr(l, "已入收件箱", "Queued Inbox"), BadgeTone::Gold),
                    _ => (tr(l, "需重试", "Failed"), BadgeTone::Danger),
                };
                let task_id = task.id.clone();
                let task_prompt = task.prompt.clone();
                let task_agent = task.agent_id.clone();
                let task_client = task.target_client.clone();
                let is_correcting = self
                    .concierge_correcting_task_id
                    .as_deref()
                    .is_some_and(|cid| cid == task.id);

                let mut meta_bar = div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.0))
                    .child(tag_chip(format!("Bot: {}", task.agent_name)))
                    .child(tag_chip(format!(
                        "{} · {}",
                        client_label(&task.target_client),
                        short_sess(&task.target_session_id)
                    )))
                    .child(tag_chip(mode_label(l, &task.mode)));

                if let Some(ref prev_cli) = task.switched_from_client {
                    meta_bar = meta_bar.child(status_badge(
                        format!("从 {} 接力", client_label(prev_cli)),
                        BadgeTone::Gold,
                    ));
                }
                if task.was_corrected {
                    meta_bar = meta_bar.child(status_badge(
                        tr(l, "已记住纠偏", "Learned Correction"),
                        BadgeTone::Success,
                    ));
                }

                let mut card = inset_panel()
                    .gap(px(8.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .min_w(px(0.0))
                                    .child(orb_mini_indicator(
                                        format!("feed-orb-{}", task.id),
                                        is_running,
                                    ))
                                    .child(
                                        div()
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .text_color(colors::ink())
                                            .child(task.prompt.clone()),
                                    ),
                            )
                            .child(status_badge(st_label, st_tone)),
                    )
                    .child(meta_bar)
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(if task.elapsed_ms > 0 {
                                format!("{} · {} ms", task.step_label, task.elapsed_ms)
                            } else {
                                task.step_label.clone()
                            }),
                    );

                if let Some(ref preview_text) = task.result_preview {
                    card = card.child(
                        div()
                            .p(px(10.0))
                            .rounded(layout::radius_control())
                            .bg(colors::surface())
                            .border_1()
                            .border_color(colors::border())
                            .text_size(typography::body_size())
                            .text_color(colors::ink())
                            .child(preview_text.clone()),
                    );
                }

                if !is_running {
                    let toggle_id = task_id.clone();
                    let retry_prompt = task_prompt.clone();
                    let retry_agent = task_agent.clone();
                    let retry_client = task_client.clone();

                    let mut action_row =
                        div().flex().flex_wrap().items_center().gap(px(6.0)).child(
                            ghost_button(
                                format!("btn-retry-{}", task.id),
                                tr(l, "↻ 重新预演/派发", "↻ Re-run"),
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.prefill_concierge_prompt(
                                        &retry_prompt,
                                        retry_agent.clone(),
                                        Some(retry_client.clone()),
                                        None,
                                        window,
                                        cx,
                                    );
                                },
                            )),
                        );

                    if !data.agents.is_empty() {
                        action_row = action_row.child(
                            ghost_button(
                                format!("btn-corr-toggle-{}", task.id),
                                if is_correcting {
                                    tr(l, "收起纠偏", "Close")
                                } else {
                                    tr(l, "派错项目了？点此纠正", "Wrong project? Correct")
                                },
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    if this.concierge_correcting_task_id.as_deref()
                                        == Some(toggle_id.as_str())
                                    {
                                        this.concierge_correcting_task_id = None;
                                    } else {
                                        this.concierge_correcting_task_id = Some(toggle_id.clone());
                                    }
                                    cx.notify();
                                },
                            )),
                        );
                    }

                    if is_correcting {
                        for bot in &data.agents {
                            let bid = bot.agent.id.clone();
                            let bname = bot.agent.name.clone();
                            let p_clone = task_prompt.clone();
                            action_row = action_row.child(
                                secondary_button(
                                    format!("btn-corr-{}-{}", task.id, bot.agent.id),
                                    format!("→ {}", bot.agent.name),
                                    ControlSize::Sm,
                                )
                                .on_click(cx.listener(
                                    move |this, _, window, cx| {
                                        let _ = dispatch_ui_action(
                                            &this.endpoint,
                                            "concierge_correct_route",
                                            json!({
                                                "prompt": p_clone,
                                                "agent_id": bid,
                                            }),
                                        );
                                        this.concierge_correcting_task_id = None;
                                        this.concierge_override_agent_id = Some(bid.clone());
                                        this.concierge_override_client = None;
                                        this.concierge_override_session_id = None;
                                        this.concierge_was_corrected = true;
                                        this.concierge_input
                                            .update(cx, |s, cx| s.set_value(&p_clone, window, cx));
                                        this.request_concierge_preview(cx);
                                        this.push_toast(
                                            format!(
                                                "已记住这类指令属于「{bname}」，下方可一键重派"
                                            ),
                                            BadgeTone::Success,
                                            cx,
                                        );
                                    },
                                )),
                            );
                        }
                    }

                    card = card.child(action_row);
                }

                feed_rows = feed_rows.child(apple_stagger_card(
                    format!("concierge-feed-{}", task.id),
                    idx,
                    card.into_any_element(),
                ));
            }
        }

        stage_items = stage_items.child(
            section_card()
                .child(section_header(
                    tr(l, "大管家派发与汇报记录", "Concierge Dispatch Feed"),
                    None,
                ))
                .child(feed_rows),
        );

        div()
            .flex_1()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .child(scroll_area("concierge-main-scroll", stage_items))
    }

    fn render_route_preview_card(
        &self,
        preview: &ConciergeRoutePreviewData,
        cx: &mut Context<Self>,
    ) -> Div {
        let l = self.locale();
        let data = &self.status.data;

        let conf_text = if preview.auto_detected {
            format!("自动判断 · {}% 把握", preview.confidence)
        } else {
            tr(l, "已按你手动指定的项目锁定", "Locked to your choice").to_string()
        };

        let mut bot_pills = div().flex().flex_wrap().items_center().gap(px(6.0));
        for bot in &data.agents {
            let is_sel = preview.selected_agent_id.as_deref() == Some(bot.agent.id.as_str());
            let bid = bot.agent.id.clone();
            let auto_id = preview.selected_agent_id.clone();
            let btn = if is_sel {
                primary_button(
                    format!("prev-bot-{}", bot.agent.id),
                    bot.agent.name.clone(),
                    ControlSize::Sm,
                )
            } else {
                secondary_button(
                    format!("prev-bot-{}", bot.agent.id),
                    bot.agent.name.clone(),
                    ControlSize::Sm,
                )
            };
            bot_pills = bot_pills.child(btn.on_click(cx.listener(move |this, _, _, cx| {
                if auto_id.as_deref() != Some(bid.as_str()) {
                    this.concierge_was_corrected = true;
                }
                this.concierge_override_agent_id = Some(bid.clone());
                this.concierge_override_session_id = None;
                this.request_concierge_preview(cx);
            })));
        }

        let mut client_pills = div().flex().flex_wrap().items_center().gap(px(6.0));
        for cli in &preview.available_clients {
            let is_sel = preview.target_client == *cli;
            let cli_owned = cli.clone();
            let cli_ready = data
                .clients
                .iter()
                .find(|c| c.client == *cli)
                .is_some_and(|c| c.cli_available);
            let label = if cli_ready {
                format!("{} ●", client_label(cli))
            } else {
                client_label(cli).to_string()
            };
            let btn = if is_sel {
                primary_button(format!("prev-cli-{cli}"), label, ControlSize::Sm)
            } else {
                secondary_button(format!("prev-cli-{cli}"), label, ControlSize::Sm)
            };
            client_pills = client_pills.child(btn.on_click(cx.listener(move |this, _, _, cx| {
                this.concierge_override_client = Some(cli_owned.clone());
                this.concierge_override_session_id = None;
                this.concierge_override_mode = None;
                this.request_concierge_preview(cx);
            })));
        }

        let modes = [
            ("memory_answer", tr(l, "先 0 Token 查记忆", "Memory First")),
            (
                "resume_latest_session",
                tr(l, "续跑/拉起 CLI", "Run CLI Session"),
            ),
            ("queue_client_inbox", tr(l, "放进收件箱", "Queue Inbox")),
        ];
        let mut mode_pills = div().flex().flex_wrap().items_center().gap(px(6.0));
        for (m_key, m_lbl) in modes {
            let is_sel = preview.mode == m_key
                || (m_key == "resume_latest_session" && preview.mode == "switch_client_handoff");
            let m_owned = m_key.to_string();
            let btn = if is_sel {
                primary_button(format!("prev-mode-{m_key}"), m_lbl, ControlSize::Sm)
            } else {
                ghost_button(format!("prev-mode-{m_key}"), m_lbl, ControlSize::Sm)
            };
            mode_pills = mode_pills.child(btn.on_click(cx.listener(move |this, _, _, cx| {
                this.concierge_override_mode = Some(m_owned.clone());
                this.request_concierge_preview(cx);
            })));
        }

        // Explicit human safety control (Read-Only default vs Workspace-Write opt-in)
        let safety_row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(tr(l, "执行权限：", "Safety:")),
            )
            .child(
                if !self.concierge_allow_write {
                    primary_button(
                        "prev-safe-ro",
                        tr(l, "只读安全（默认）", "Read-Only (Default)"),
                        ControlSize::Sm,
                    )
                } else {
                    ghost_button(
                        "prev-safe-ro",
                        tr(l, "只读安全（默认）", "Read-Only (Default)"),
                        ControlSize::Sm,
                    )
                }
                .on_click(cx.listener(|this, _, _, cx| {
                    this.concierge_allow_write = false;
                    this.request_concierge_preview(cx);
                })),
            )
            .child(
                if self.concierge_allow_write {
                    primary_button(
                        "prev-safe-rw",
                        tr(l, "允许改项目代码", "Allow Workspace Writes"),
                        ControlSize::Sm,
                    )
                } else {
                    ghost_button(
                        "prev-safe-rw",
                        tr(l, "允许改项目代码", "Allow Workspace Writes"),
                        ControlSize::Sm,
                    )
                }
                .on_click(cx.listener(|this, _, _, cx| {
                    this.concierge_allow_write = true;
                    this.request_concierge_preview(cx);
                })),
            );

        let cli_status_badge = if preview.client_cli_available {
            status_badge(tr(l, "本机 CLI 就绪", "CLI Ready"), BadgeTone::Success)
        } else {
            status_badge(
                tr(l, "未检出 CLI · 将走收件箱", "No CLI · Inbox Fallback"),
                BadgeTone::Warning,
            )
        };

        let mut session_box = inset_panel()
            .gap(px(4.0))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(colors::ink())
                            .child(format!(
                                "{}：{} ({})",
                                tr(l, "将接续的会话", "Target Session"),
                                client_label(&preview.target_client),
                                short_sess(&preview.target_session_id)
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .child(cli_status_badge)
                            .child(status_badge(
                                mode_label(l, &preview.mode),
                                if preview.mode == "switch_client_handoff" {
                                    BadgeTone::Warning
                                } else {
                                    BadgeTone::Neutral
                                },
                            )),
                    ),
            )
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(preview.target_session_summary.clone()),
            );

        if let Some(ref wd) = preview.working_dir {
            session_box = session_box.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(format!("{}：{wd}", tr(l, "工作目录", "Working Dir"))),
            );
        }

        let mut card = section_card()
            .border_color(colors::gold())
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(fuli_icon("sparkles", 15.0, colors::gold()))
                            .child(
                                div()
                                    .text_size(typography::control_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .child(tr(
                                        l,
                                        "先给你看派发方案 · 错了点一下就能改",
                                        "Route Preview — click any pill to adjust",
                                    )),
                            ),
                    )
                    .child(status_badge(
                        conf_text,
                        if preview.auto_detected {
                            BadgeTone::Gold
                        } else {
                            BadgeTone::Success
                        },
                    )),
            )
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(preview.reason.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(colors::muted())
                            .child(tr(l, "1. 执行项目（FULI Bot）", "1. Target FULI Bot")),
                    )
                    .child(bot_pills),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "2. 执行客户端（带 ● 表示本机 CLI 就绪，随时可切）",
                                "2. Execution Client (● = local CLI ready)",
                            )),
                    )
                    .child(client_pills),
            )
            .child(session_box)
            .child(safety_row);

        if preview.can_answer_from_memory {
            card = card.child(status_badge(
                tr(
                    l,
                    "✦ 记忆库已有现成答案 · 可 0 Token 直接回复，不打扰运行中会话",
                    "✦ Memory hit ready — can answer in 0 tokens without waking live sessions",
                ),
                BadgeTone::Success,
            ));
        }

        if let Some(ref brief) = preview.handoff_brief_preview {
            card = card.child(
                div()
                    .p(px(10.0))
                    .rounded(layout::radius_control())
                    .bg(colors::subtle())
                    .border_1()
                    .border_color(colors::gold())
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_STRONG)
                            .text_color(colors::gold())
                            .child(tr(
                                l,
                                "⇄ 跨端无缝切换 · 将自动携带以下精简进度与红线（不灌流水账）",
                                "⇄ Cross-Client Switch · Compact Handoff Brief",
                            )),
                    )
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::ink())
                            .child(brief.clone()),
                    ),
            );
        }

        card.child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .pt(px(4.0))
                .child(mode_pills)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            ghost_button(
                                "btn-prev-cancel",
                                tr(l, "取消", "Cancel"),
                                ControlSize::Md,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.concierge_preview = None;
                                this.concierge_was_corrected = false;
                                this.concierge_allow_write = false;
                                cx.notify();
                            })),
                        )
                        .child(
                            primary_button(
                                "btn-prev-confirm",
                                tr(l, "确认并派发", "Confirm & Dispatch"),
                                ControlSize::Md,
                            )
                            .on_click(cx.listener(
                                |this, _, window, cx| {
                                    this.dispatch_concierge_now(window, cx);
                                },
                            )),
                        ),
                ),
        )
    }

    fn render_concierge_task_sidebar(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let running_count = self.running_concierge_count();

        let mut active_list = div().flex().flex_col().gap(px(8.0));
        if data.concierge_tasks.is_empty() {
            active_list = active_list.child(
                inset_panel()
                    .gap(px(4.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(orb_mini_indicator("side-idle-orb", false))
                            .child(
                                div()
                                    .text_size(typography::control_size())
                                    .font_weight(typography::WEIGHT_MEDIUM)
                                    .text_color(colors::ink())
                                    .child(tr(
                                        l,
                                        "当前安静运行，无阻塞任务",
                                        "All quiet — no running tasks",
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "在左侧发一句话，这里会实时显示每个正在跑的任务阶段、所属 Bot 与会话。",
                                "Dispatch anything on the left to see live running steps, Bots, and sessions here.",
                            )),
                    ),
            );
        } else {
            for task in data.concierge_tasks.iter().take(5) {
                let is_running = task.status == "running" || task.status == "queued";
                let ratio = if is_running { 0.62 } else { 1.0 };
                let bar_color = if is_running {
                    colors::gold()
                } else if task.status == "completed" {
                    colors::success()
                } else {
                    colors::warning()
                };

                active_list = active_list.child(
                    inset_panel()
                        .gap(px(6.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(6.0))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(6.0))
                                        .min_w(px(0.0))
                                        .child(orb_mini_indicator(
                                            format!("side-task-orb-{}", task.id),
                                            is_running,
                                        ))
                                        .child(
                                            div()
                                                .text_size(typography::control_size())
                                                .font_weight(typography::WEIGHT_MEDIUM)
                                                .text_color(colors::ink())
                                                .child(task.agent_name.clone()),
                                        ),
                                )
                                .child(tag_chip(client_label(&task.target_client))),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::ink())
                                .child(task.prompt.chars().take(48).collect::<String>()),
                        )
                        .child(progress_bar_animated(
                            format!("side-task-bar-{}", task.id),
                            ratio,
                            bar_color,
                        ))
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(task.step_label.clone()),
                        ),
                );
            }
        }

        let mut radar_list = div().flex().flex_col().gap(px(8.0));
        if data.bot_session_ledgers.is_empty() {
            radar_list = radar_list.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(tr(
                        l,
                        "还没有注册任何 FULI Bot，去「项目」页新建后会自动出现在这里。",
                        "No FULI Bots yet — create one in Projects to see its sessions here.",
                    )),
            );
        } else {
            for ledger in &data.bot_session_ledgers {
                let presence = if ledger.latest_session.is_some() {
                    AvatarPresence::Online
                } else {
                    AvatarPresence::None
                };
                let aid = ledger.agent_id.clone();
                let aname = ledger.agent_name.clone();
                let latest_cli = ledger
                    .latest_session
                    .as_ref()
                    .map(|s| s.client_id.clone())
                    .unwrap_or_else(|| "claude-code".to_string());
                let latest_sid = ledger.latest_session.as_ref().map(|s| s.session_id.clone());

                let session_line = match &ledger.latest_session {
                    Some(s) => format!(
                        "{} ({}) · {}",
                        client_label(&s.client_id),
                        short_sess(&s.session_id),
                        s.summary
                    ),
                    None => {
                        tr(l, "暂无历史会话 · 点右上角可扫描导入", "No sessions yet").to_string()
                    }
                };

                let ws_line = match (
                    &ledger.active_workstream_title,
                    &ledger.active_workstream_state,
                ) {
                    (Some(title), Some(st)) => Some(format!("工作线「{title}」：{st}")),
                    (Some(title), None) => Some(format!("进行中工作线：{title}")),
                    _ => None,
                };

                let aid_resume = aid.clone();
                let aname_resume = aname.clone();
                let cli_resume = latest_cli.clone();
                let sid_resume = latest_sid.clone();

                let aid_switch = aid.clone();
                let aname_switch = aname.clone();
                let alt_cli = pick_alternate_client(&latest_cli).to_string();
                let alt_cli_label = client_label(&alt_cli);

                let mut row = inset_panel()
                    .gap(px(6.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .min_w(px(0.0))
                                    .child(fuli_avatar(
                                        format!("radar-av-{}", ledger.agent_id),
                                        &ledger.agent_name,
                                        AvatarSize::Sm,
                                        presence,
                                    ))
                                    .child(
                                        div()
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_STRONG)
                                            .text_color(colors::ink())
                                            .child(ledger.agent_name.clone()),
                                    ),
                            )
                            .child(tag_chip(format!(
                                "{} {}",
                                ledger.recent_sessions.len(),
                                tr(l, "会话", "sess")
                            ))),
                    )
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(session_line),
                    );

                if let Some(wl) = ws_line {
                    row = row.child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::ink())
                            .child(wl),
                    );
                }

                let mut btn_row = div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.0))
                    .pt(px(2.0))
                    .child(
                        secondary_button(
                            format!("btn-radar-resume-{}", ledger.agent_id),
                            tr(l, "续跑最近会话", "Resume Latest"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.prefill_concierge_prompt(
                                    &format!("继续 {aname_resume} 最近会话的工作"),
                                    Some(aid_resume.clone()),
                                    Some(cli_resume.clone()),
                                    sid_resume.clone(),
                                    window,
                                    cx,
                                );
                            },
                        )),
                    )
                    .child(
                        ghost_button(
                            format!("btn-radar-switch-{}", ledger.agent_id),
                            format!("切到 {alt_cli_label}"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.prefill_concierge_prompt(
                                    &format!(
                                        "切到 {alt_cli_label} 继续推进 {aname_switch} 的工作线"
                                    ),
                                    Some(aid_switch.clone()),
                                    Some(alt_cli.clone()),
                                    None,
                                    window,
                                    cx,
                                );
                            },
                        )),
                    );

                if let Some(ref sid_for_copy) = latest_sid {
                    let cmd_str = session_resume_command(&latest_cli, sid_for_copy);
                    btn_row = btn_row.child(
                        ghost_button(
                            format!("btn-radar-copy-{}", ledger.agent_id),
                            tr(l, "复制命令", "Copy CLI"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(cmd_str.clone()));
                            let msg = tr(
                                this.locale(),
                                "已复制原生会话续接命令到剪贴板",
                                "Copied native resume command",
                            );
                            this.push_toast(msg, BadgeTone::Success, cx);
                        })),
                    );
                }

                row = row.child(btn_row);
                radar_list = radar_list.child(row);
            }
        }

        let sidebar_col = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .pb(px(16.0))
            .child(
                section_card()
                    .child(section_header(
                        if running_count > 0 {
                            format!(
                                "{} ({running_count})",
                                tr(l, "正在运行的任务", "Running Tasks")
                            )
                        } else {
                            tr(l, "正在运行与最近任务", "Active & Recent Tasks").to_string()
                        },
                        None,
                    ))
                    .child(active_list),
            )
            .child(
                section_card()
                    .child(section_header(
                        tr(l, "全部 Bot 与最近会话记忆", "All Bot Sessions"),
                        Some(
                            secondary_button(
                                "btn-sync-local-sessions",
                                tr(l, "扫描导入", "Sync Local"),
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.sync_local_sessions_now(cx);
                            }))
                            .into_any_element(),
                        ),
                    ))
                    .child(radar_list),
            );

        div()
            .w(px(360.0))
            .flex_shrink_0()
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .child(scroll_area("concierge-side-scroll", sidebar_col))
    }
}
