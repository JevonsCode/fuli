#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod concierge;
mod graph;
mod memory;
mod state;

use std::time::Duration;

use fuli_domain::{
    AutonomyLevel, ConstraintClass, DeliveryMode, KbItemStatus, LinkAuthority, RuleScope,
    RuleStatus, WakeStatus, WorkflowStatus, WorkstreamStatus,
};
use fuli_ipc::{IpcRequest, resolve_ipc_name, send_request};
use fuli_ui_kit::{
    AvatarPresence, AvatarSize, BadgeTone, ControlSize, CopyKey, FuliAssets, InputEvent,
    InputState, LoadingSize, Locale, ToastPlacement, TourAnchor, apple_stagger_card,
    apple_view_transition, apply_fuli_theme, colors, conflict_split_card, copy_button,
    danger_button, detail_drawer, divider, empty_state, floating_toast_overlay, form_field,
    fuli_app_icon, fuli_avatar, fuli_brand_lockup, fuli_loading, fuli_loading_mark, fuli_shell,
    fuli_window_options, fuli_wordmark_en, fuli_wordmark_zh, ghost_button, guided_tour_popover,
    inset_list_row, inset_panel, kbd_chip, kv_row, layout, modal_overlay, notice_banner,
    orb_mini_indicator, primary_button, progress_bar_animated, scroll_area, search_bar,
    secondary_button, section_card, section_header, segmented_tab, setting_toggle_row,
    sidebar_nav_item, sparkline_line, spring_dock_slot, spring_floating_dock, spring_segment_slot,
    spring_segmented_control, stat_tile, status_badge, status_pill_button, tag_chip, text_input,
    toggle_switch, top_icon_button, typography,
};
use gpui_kit::*;
use serde_json::json;

use state::{
    ConciergeRoutePreviewData, DaemonStatusView, ItemDetailData, SearchResultData,
    dispatch_ui_action, session_resume_command,
};

#[inline]
fn tr(locale: Locale, zh: &'static str, en: &'static str) -> &'static str {
    match locale {
        Locale::ZhCn => zh,
        Locale::EnUs => en,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavTab {
    Today,
    Agents,
    Memory,
    Graph,
    Roundtable,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsSubTab {
    Clients,
    General,
    Audit,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemorySubTab {
    Knowledge,
    Rules,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConciergeSubTab {
    Commander,
    Inbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KbFilter {
    All,
    Proposal,
    Confirmed,
    Deprecated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveModal {
    None,
    NewAgent,
    NewKnowledge,
    NewRule,
    AskRoundtable,
}

struct FuliAppView {
    endpoint: String,
    close_grace_secs: u64,
    tab: NavTab,
    settings_sub: SettingsSubTab,
    memory_sub: MemorySubTab,
    pub(crate) concierge_sub: ConciergeSubTab,
    kb_filter: KbFilter,
    selected_agent_id: Option<String>,
    selected_kb_id: Option<String>,
    graph_selected_kb_id: Option<String>,
    graph_pan: (f32, f32),
    graph_zoom: f32,
    graph_dragging: bool,
    graph_drag_last: Option<Point<Pixels>>,
    graph_did_drag: bool,
    graph_inspector_open: bool,
    toast_seq: u64,
    toast: Option<(String, BadgeTone)>,
    tour_step: Option<usize>,
    copied_session_key: Option<String>,
    search_input: Entity<InputState>,
    search_result: Option<SearchResultData>,
    pub(crate) concierge_input: Entity<InputState>,
    pub(crate) concierge_preview: Option<ConciergeRoutePreviewData>,
    pub(crate) concierge_override_agent_id: Option<String>,
    pub(crate) concierge_override_client: Option<String>,
    pub(crate) concierge_override_session_id: Option<String>,
    pub(crate) concierge_override_mode: Option<String>,
    pub(crate) concierge_allow_write: bool,
    pub(crate) concierge_was_corrected: bool,
    pub(crate) concierge_polling_active: bool,
    pub(crate) concierge_correcting_task_id: Option<String>,
    detail_item: Option<ItemDetailData>,
    active_modal: ActiveModal,
    form_title: Entity<InputState>,
    form_body: Entity<InputState>,
    form_extra: Entity<InputState>,
    rule_scope: RuleScope,
    rule_class: ConstraintClass,
    status: DaemonStatusView,
    _subscriptions: Vec<Subscription>,
}

impl FuliAppView {
    fn new(
        endpoint: String,
        close_grace_secs: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let status = DaemonStatusView::fetch(&endpoint);
        let selected_agent_id = status.data.agents.first().map(|a| a.agent.id.clone());
        let selected_kb_id = status.data.knowledge_bases.first().map(|k| k.id.clone());
        let graph_selected_kb_id = None;

        let search_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("输入中文或英文关键词搜索知识（回车即查）...")
        });
        let concierge_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("只跟大管家说一句话（回车先看分配方案，错了随时改）...")
        });
        let form_title = cx.new(|cx| InputState::new(window, cx).placeholder("简短标题 / 名称..."));
        let form_body =
            cx.new(|cx| InputState::new(window, cx).placeholder("具体内容、规矩或描述..."));
        let form_extra = cx.new(|cx| {
            InputState::new(window, cx).placeholder("可选：目录路径 / 检索词 / 会话 ID...")
        });

        let search_sub = cx.subscribe_in(
            &search_input,
            window,
            |this, _state, ev: &InputEvent, _, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    this.execute_search(cx);
                }
            },
        );
        let concierge_sub_ev = cx.subscribe_in(
            &concierge_input,
            window,
            |this, _state, ev: &InputEvent, _, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    this.request_concierge_preview(cx);
                }
            },
        );

        Self {
            endpoint,
            close_grace_secs,
            tab: NavTab::Today,
            settings_sub: SettingsSubTab::Clients,
            memory_sub: MemorySubTab::Knowledge,
            concierge_sub: ConciergeSubTab::Commander,
            kb_filter: KbFilter::All,
            selected_agent_id,
            selected_kb_id,
            graph_selected_kb_id,
            graph_pan: (0.0, 0.0),
            graph_zoom: 1.0,
            graph_dragging: false,
            graph_drag_last: None,
            graph_did_drag: false,
            graph_inspector_open: false,
            toast_seq: 0,
            toast: None,
            tour_step: None,
            copied_session_key: None,
            search_input,
            search_result: None,
            concierge_input,
            concierge_preview: None,
            concierge_override_agent_id: None,
            concierge_override_client: None,
            concierge_override_session_id: None,
            concierge_override_mode: None,
            concierge_allow_write: false,
            concierge_was_corrected: false,
            concierge_polling_active: false,
            concierge_correcting_task_id: None,
            detail_item: None,
            active_modal: ActiveModal::None,
            form_title,
            form_body,
            form_extra,
            rule_scope: RuleScope::Agent,
            rule_class: ConstraintClass::HardRule,
            status,
            _subscriptions: vec![search_sub, concierge_sub_ev],
        }
    }

    fn locale(&self) -> Locale {
        Locale::from_code(&self.status.data.ui_locale)
    }

    fn push_toast(&mut self, msg: impl Into<String>, tone: BadgeTone, cx: &mut Context<Self>) {
        self.toast_seq += 1;
        let seq = self.toast_seq;
        self.toast = Some((msg.into(), tone));
        cx.notify();

        if tone != BadgeTone::Danger {
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(3800))
                    .await;
                let _ = this.update(cx, |view, cx| {
                    if view.toast_seq == seq {
                        view.toast = None;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.status = DaemonStatusView::fetch(&self.endpoint);
        if self.selected_agent_id.is_none() {
            self.selected_agent_id = self.status.data.agents.first().map(|a| a.agent.id.clone());
        }
        if self.selected_kb_id.is_none() {
            self.selected_kb_id = self
                .status
                .data
                .knowledge_bases
                .first()
                .map(|k| k.id.clone());
        }
        if self.graph_selected_kb_id.is_none() {
            self.graph_selected_kb_id = self.selected_kb_id.clone();
        }
        cx.notify();
    }

    fn run_action(
        &mut self,
        action: &str,
        payload: serde_json::Value,
        ok_msg: &str,
        cx: &mut Context<Self>,
    ) {
        match dispatch_ui_action(&self.endpoint, action, payload) {
            Ok(_) => {
                self.refresh(cx);
                self.push_toast(ok_msg, BadgeTone::Success, cx);
            }
            Err(err) => {
                self.push_toast(format!("操作没成功：{err}"), BadgeTone::Danger, cx);
            }
        }
    }

    fn execute_search(&mut self, cx: &mut Context<Self>) {
        let query = self.search_input.read(cx).value().trim().to_string();
        if query.is_empty() {
            self.search_result = None;
            cx.notify();
            return;
        }
        let payload = json!({
            "query": query,
            "kbId": self.selected_kb_id,
            "includeProposals": true,
            "limit": 12
        });
        match dispatch_ui_action(&self.endpoint, "search_knowledge", payload) {
            Ok(val) => match serde_json::from_value::<SearchResultData>(val) {
                Ok(res) => {
                    self.search_result = Some(res);
                    self.toast = None;
                }
                Err(err) => {
                    self.toast = Some((format!("解析搜索结果失败：{err}"), BadgeTone::Danger));
                }
            },
            Err(err) => {
                self.toast = Some((format!("搜索失败：{err}"), BadgeTone::Danger));
            }
        }
        cx.notify();
    }

    fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_input
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.search_result = None;
        cx.notify();
    }

    fn open_item_drawer(&mut self, item_id: &str, cx: &mut Context<Self>) {
        match dispatch_ui_action(
            &self.endpoint,
            "get_knowledge_item",
            json!({ "itemId": item_id }),
        ) {
            Ok(val) => match serde_json::from_value::<ItemDetailData>(val) {
                Ok(detail) => self.detail_item = Some(detail),
                Err(err) => {
                    self.toast = Some((format!("无法读取版本历史：{err}"), BadgeTone::Danger));
                }
            },
            Err(err) => {
                self.toast = Some((format!("读取条目失败：{err}"), BadgeTone::Danger));
            }
        }
        cx.notify();
    }

    fn open_modal(&mut self, modal: ActiveModal, window: &mut Window, cx: &mut Context<Self>) {
        self.form_title
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.form_body
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.form_extra
            .update(cx, |s, cx| s.set_value("", window, cx));
        self.active_modal = modal;
        cx.notify();
    }

    fn submit_modal(&mut self, cx: &mut Context<Self>) {
        let title = self.form_title.read(cx).value().trim().to_string();
        let body = self.form_body.read(cx).value().trim().to_string();
        let extra = self.form_extra.read(cx).value().trim().to_string();

        match self.active_modal {
            ActiveModal::None => {}
            ActiveModal::NewAgent => {
                if title.is_empty() {
                    self.toast = Some(("请先填写 FULI Bot 名称".into(), BadgeTone::Warning));
                    cx.notify();
                    return;
                }
                let mut payload = json!({
                    "name": title,
                    "description": body,
                    "replyLang": self.locale().code(),
                });
                if !extra.is_empty() {
                    if extra.contains("git@") || extra.contains("http") {
                        payload["gitRemote"] = json!(extra);
                    } else {
                        payload["dirPath"] = json!(extra);
                    }
                }
                self.active_modal = ActiveModal::None;
                self.run_action("create_agent", payload, "已创建新的 FULI Bot 档案", cx);
            }
            ActiveModal::NewKnowledge => {
                if title.is_empty() || body.is_empty() {
                    self.toast = Some(("标题和正文都需要填写".into(), BadgeTone::Warning));
                    cx.notify();
                    return;
                }
                let Some(ref kb_id) = self.selected_kb_id else {
                    self.toast = Some(("请先创建一个项目或选择知识库".into(), BadgeTone::Warning));
                    cx.notify();
                    return;
                };
                let aliases: Vec<String> = extra
                    .split([',', '，'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .collect();
                let payload = json!({
                    "kbId": kb_id,
                    "title": title,
                    "body": body,
                    "aliases": aliases,
                    "itemType": "fact",
                    "lang": self.locale().code(),
                    "humanExplicit": true
                });
                self.active_modal = ActiveModal::None;
                self.run_action("create_kb_item", payload, "已记入知识库并建好检索索引", cx);
            }
            ActiveModal::NewRule => {
                if body.is_empty() {
                    self.toast = Some(("请填写规矩或偏好的具体内容".into(), BadgeTone::Warning));
                    cx.notify();
                    return;
                }
                let pref_key = if title.is_empty() {
                    "custom.rule".to_string()
                } else {
                    title
                };
                let mut payload = json!({
                    "scopeKind": self.rule_scope.as_str(),
                    "constraintClass": self.rule_class.as_str(),
                    "prefKey": pref_key,
                    "content": body,
                    "rationale": extra,
                    "humanExplicit": true
                });
                if self.rule_scope == RuleScope::Agent {
                    let Some(ref aid) = self.selected_agent_id else {
                        self.toast = Some((
                            "项目级规矩需要先选中一个 FULI Bot".into(),
                            BadgeTone::Warning,
                        ));
                        cx.notify();
                        return;
                    };
                    payload["agentId"] = json!(aid);
                }
                self.active_modal = ActiveModal::None;
                self.run_action(
                    "create_rule",
                    payload,
                    "新规矩/偏好已立即生效（随时可撤回）",
                    cx,
                );
            }
            ActiveModal::AskRoundtable => {
                if title.is_empty() || body.is_empty() {
                    self.toast = Some(("请填写目标客户端和问题内容".into(), BadgeTone::Warning));
                    cx.notify();
                    return;
                }
                let target_session = if extra.is_empty() {
                    "default".to_string()
                } else {
                    extra
                };
                let payload = json!({
                    "agentId": self.selected_agent_id,
                    "toClient": title,
                    "toSessionId": target_session,
                    "question": body,
                    "attemptNativeWake": false
                });
                self.active_modal = ActiveModal::None;
                self.run_action(
                    "ask_agent",
                    payload,
                    "已发送圆桌问询，对方客户端下次交互将自动收到",
                    cx,
                );
            }
        }
    }

    fn switch_tab(&mut self, tab: NavTab, cx: &mut Context<Self>) {
        self.tab = tab;
        self.toast = None;
        self.detail_item = None;
        cx.notify();
    }

    fn pending_total(&self) -> usize {
        let data = &self.status.data;
        data.rule_conflicts.len()
            + data.pending.proposed_items.len()
            + data.pending.pending_rules.len()
            + data.pending.proposed_workflows.len()
            + data.pending.stale_items.len()
    }

    // =========================================================================
    // View 1: Today (v0.27.16 Left Fixed Compounding Stage + Right Scroll Stream)
    // =========================================================================

    fn render_today(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let portfolio = &data.portfolio;

        let pending_total = self.pending_total();
        let confirmed_kb_count = data
            .kb_items
            .iter()
            .filter(|i| i.status == KbItemStatus::Confirmed)
            .count();
        let active_rules_count = data
            .rules
            .iter()
            .filter(|r| r.status == RuleStatus::Active)
            .count();
        let saved_total = (confirmed_kb_count + active_rules_count) as i64;

        // Build cumulative curve for the minimalist polyline (combines real weekly compounding with accumulated total)
        let mut trend_series = portfolio.weekly_compounding_series.clone();
        if trend_series.iter().all(|&v| v == 0) && saved_total > 0 {
            let n = trend_series.len().max(7);
            trend_series = (0..n)
                .map(|idx| {
                    if idx + 1 == n {
                        saved_total
                    } else if idx + 2 == n {
                        (saved_total * 4 / 5).max(1)
                    } else if idx + 3 == n {
                        (saved_total / 3).max(1)
                    } else {
                        (saved_total / 10).max(0)
                    }
                })
                .collect();
        }
        let trend_start = trend_series.first().copied().unwrap_or(0);
        let trend_end = trend_series.last().copied().unwrap_or(saved_total);

        let connected_clients = data.clients.iter().filter(|c| c.fuli_configured).count();

        let left_stage = div()
            .w(px(420.0))
            .flex_shrink_0()
            .min_h(px(0.0))
            .pb(px(62.0))
            .flex()
            .flex_col()
            .child(
                section_card()
                    .flex_1()
                    .justify_between()
                    .child(section_header(
                        l.t(CopyKey::WeeklyStatement),
                        Some(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(
                                    ghost_button(
                                        "today-all-mem",
                                        tr(l, "查看详情 ›", "Details ›"),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Memory, cx);
                                    })),
                                )
                                .into_any_element(),
                        ),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(14.0))
                            .child(
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .text_size(typography::headline_figure_size())
                                            .font_weight(typography::WEIGHT_STRONG)
                                            .text_color(colors::ink())
                                            .child(saved_total.to_string()),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::body_size())
                                            .text_color(colors::muted())
                                            .child(tr(
                                                l,
                                                "条习惯和经验，是你一共攒下的",
                                                "rules & takeaways you have compounded",
                                            )),
                                    ),
                            )
                            .child(sparkline_line(&trend_series, 152.0))
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child(if l == Locale::ZhCn {
                                        format!(
                                            "最近 {} 周从 {trend_start} 条积累到 {trend_end} 条 · 后台常驻 {:.1} MiB",
                                            trend_series.len(),
                                            self.status.daemon_mem.working_set_mib()
                                        )
                                    } else {
                                        format!(
                                            "Last {} weeks: {trend_start} → {trend_end} · Daemon {:.1} MiB",
                                            trend_series.len(),
                                            self.status.daemon_mem.working_set_mib()
                                        )
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.0))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(10.0))
                                    .child(
                                        div()
                                            .id("tile-jump-graph")
                                            .flex_1()
                                            .cursor_pointer()
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.switch_tab(NavTab::Graph, cx);
                                            }))
                                            .child(stat_tile(
                                                portfolio.total_agents.to_string(),
                                                tr(l, "个活跃项目", "Active Projects"),
                                                format!(
                                                    "{} {} · {} ›",
                                                    connected_clients,
                                                    tr(l, "个已接客户端", "clients"),
                                                    tr(l, "看关系图", "Map")
                                                ),
                                            )),
                                    )
                                    .child(
                                        div()
                                            .id("tile-jump-audit")
                                            .flex_1()
                                            .cursor_pointer()
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.settings_sub = SettingsSubTab::Audit;
                                                this.switch_tab(NavTab::Settings, cx);
                                            }))
                                            .child(stat_tile(
                                                portfolio.compounding_events_count.to_string(),
                                                tr(l, "次被用上", "Times Reused"),
                                                format!(
                                                    "~{} {} ›",
                                                    data.tokens_saved,
                                                    tr(l, "字已省下", "tokens saved")
                                                ),
                                            )),
                                    ),
                            )
                            .child(
                                div()
                                    .id("tile-jump-memory")
                                    .w_full()
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Memory, cx);
                                    }))
                                    .child(stat_tile(
                                        pending_total.to_string(),
                                        tr(l, "条新学到或待你拍板", "New or Waiting for You"),
                                        if data.rule_conflicts.is_empty() {
                                            tr(
                                                l,
                                                "目前没有红线冲突，点右侧卡片即可一键确认 ›",
                                                "Zero rule conflicts — confirm on the right ›",
                                            )
                                            .into()
                                        } else {
                                            format!(
                                                "{} {} ›",
                                                data.rule_conflicts.len(),
                                                tr(
                                                    l,
                                                    "处红线规矩冲突，需要你二选一",
                                                    "rule conflicts need your call"
                                                )
                                            )
                                        },
                                    )),
                            ),
                    ),
            );

        let mut decisions_card = section_card().child(section_header(
            l.t(CopyKey::WaitingForYou),
            Some(
                status_badge(
                    format!("{pending_total}"),
                    if pending_total == 0 {
                        BadgeTone::Success
                    } else if !data.rule_conflicts.is_empty() {
                        BadgeTone::Danger
                    } else {
                        BadgeTone::Warning
                    },
                )
                .into_any_element(),
            ),
        ));

        if pending_total == 0 {
            decisions_card = decisions_card.child(empty_state(
                l.t(CopyKey::AllClearTitle),
                l.t(CopyKey::AllClearSub),
            ));
        } else {
            for (idx, conflict) in data.rule_conflicts.iter().enumerate() {
                if let Some(card) = self.render_conflict_card("today", idx, conflict, cx) {
                    decisions_card = decisions_card.child(card);
                }
            }

            for (idx, rule) in data.pending.pending_rules.iter().enumerate() {
                let rid_ok = rule.id.clone();
                let rid_hard = rule.id.clone();
                let rid_no = rule.id.clone();
                decisions_card = decisions_card.child(
                    inset_panel()
                        .child(
                            div()
                                .text_size(typography::body_size())
                                .font_weight(typography::WEIGHT_MEDIUM)
                                .child(rule.content.clone()),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    primary_button(
                                        format!("approve-rule-{idx}"),
                                        l.t(CopyKey::ConfirmBtn),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "approve_rule",
                                                json!({ "id": rid_ok, "promote_to_hard": false }),
                                                "已生效，之后对话会自动带上这条偏好",
                                                cx,
                                            );
                                        },
                                    )),
                                )
                                .child(
                                    secondary_button(
                                        format!("hard-rule-{idx}"),
                                        l.t(CopyKey::PromoteHardBtn),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "approve_rule",
                                                json!({ "id": rid_hard, "promote_to_hard": true }),
                                                "已升格为红线规矩",
                                                cx,
                                            );
                                        },
                                    )),
                                )
                                .child(
                                    danger_button(
                                        format!("drop-rule-{idx}"),
                                        l.t(CopyKey::DismissBtn),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "disable_rule",
                                                json!({ "id": rid_no }),
                                                "已忽略这条建议",
                                                cx,
                                            );
                                        },
                                    )),
                                ),
                        ),
                );
            }

            for (idx, item) in data.pending.proposed_items.iter().enumerate() {
                let iid_ok = item.id.clone();
                let iid_no = item.id.clone();
                decisions_card = decisions_card.child(
                    inset_panel()
                        .child(
                            div()
                                .text_size(typography::body_size())
                                .font_weight(typography::WEIGHT_MEDIUM)
                                .child(item.title.clone()),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(item.body.chars().take(120).collect::<String>()),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .child(
                                    primary_button(
                                        format!("confirm-kb-{idx}"),
                                        l.t(CopyKey::ConfirmBtn),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "confirm_kb_item",
                                                json!({ "id": iid_ok }),
                                                "已存入知识库，之后检索就能命中",
                                                cx,
                                            );
                                        },
                                    )),
                                )
                                .child(
                                    secondary_button(
                                        format!("drop-kb-{idx}"),
                                        l.t(CopyKey::DismissBtn),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "deprecate_kb_item",
                                                json!({ "id": iid_no }),
                                                "已废弃该条提议",
                                                cx,
                                            );
                                        },
                                    )),
                                ),
                        ),
                );
            }
        }

        let mut dreaming_card = section_card().child(section_header(
            l.t(CopyKey::DreamingTitle),
            Some(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(fuli_loading_mark("today-dream-mark", LoadingSize::Inline))
                    .child(
                        secondary_button(
                            "btn-dreaming-run",
                            l.t(CopyKey::DreamingRunBtn),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.run_action(
                                "run_dreaming",
                                json!({}),
                                "已完成本地零模型整理扫描",
                                cx,
                            );
                        })),
                    )
                    .into_any_element(),
            ),
        ));
        dreaming_card = dreaming_card.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(format!(
                    "{}: {} · {}: {} · {}: {} · {}: {}",
                    tr(l, "已扫描", "Scanned"),
                    data.dreaming.scanned_items,
                    tr(l, "重复组", "Duplicates"),
                    data.dreaming.duplicate_pairs_found,
                    tr(l, "过时", "Stale"),
                    data.dreaming.stale_items_found,
                    tr(l, "可沉淀", "Promote"),
                    data.dreaming.promotion_candidates_found
                )),
        );
        for sug in &data.dreaming.suggestions {
            dreaming_card = dreaming_card.child(notice_banner(
                BadgeTone::Gold,
                sug.headline.clone(),
                format!("{} · {}", sug.detail, sug.action_hint),
            ));
        }

        let mut portfolio_card = section_card().child(section_header(
            l.t(CopyKey::PortfolioTitle),
            Some(
                status_badge(format!("{}d", portfolio.since_days), BadgeTone::Neutral)
                    .into_any_element(),
            ),
        ));
        if portfolio.recent_checkpoints.is_empty() {
            portfolio_card = portfolio_card.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(tr(
                        l,
                        "当你在 Claude Code / Codex 里记录里程碑后，这里会自动汇总所有项目的进展，方便写日报和周报。",
                        "Milestones saved from Claude Code or Codex automatically appear here for effortless daily/weekly summaries.",
                    )),
            );
        } else {
            for (idx, cp) in portfolio.recent_checkpoints.iter().enumerate() {
                portfolio_card = portfolio_card.child(
                    inset_panel().child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(fuli_avatar(
                                format!("today-cp-av-{idx}"),
                                &cp.agent_name,
                                AvatarSize::Md,
                                AvatarPresence::Working,
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.0))
                                    .child(
                                        div()
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .child(format!(
                                                "{} · {}",
                                                cp.agent_name, cp.workstream_title
                                            )),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::muted())
                                            .child(format!(
                                                "{} ({})",
                                                cp.current_state, cp.source_client
                                            )),
                                    ),
                            ),
                    ),
                );
            }
        }

        let right_stream = div()
            .w_full()
            .min_w(px(0.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .pb(px(12.0))
            .child(apple_stagger_card(
                "today-card-0",
                0,
                decisions_card.into_any_element(),
            ))
            .child(apple_stagger_card(
                "today-card-1",
                1,
                dreaming_card.into_any_element(),
            ))
            .child(apple_stagger_card(
                "today-card-2",
                2,
                portfolio_card.into_any_element(),
            ));

        div()
            .flex_1()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(left_stage)
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(scroll_area("today-right-scroll", right_stream)),
            )
    }

    fn render_conflict_card(
        &self,
        prefix: &str,
        idx: usize,
        conflict: &fuli_domain::RuleConflict,
        cx: &mut Context<Self>,
    ) -> Option<Div> {
        if conflict.candidates.len() < 2 {
            return None;
        }
        let l = self.locale();
        let left_rule = conflict.candidates[0].clone();
        let right_rule = conflict.candidates[1].clone();
        let left_id = left_rule.id.clone();
        let right_id = right_rule.id.clone();
        let all_ids: Vec<String> = conflict.candidates.iter().map(|c| c.id.clone()).collect();
        let all_ids_r = all_ids.clone();

        let scope_label = |scope: RuleScope| match scope {
            RuleScope::PersonalGlobal => tr(l, "全局红线", "Global Rule"),
            RuleScope::Agent => tr(l, "项目红线", "Project Rule"),
        };

        let left_box = div()
            .w_full()
            .min_w(px(0.0))
            .px(px(14.0))
            .py(px(11.0))
            .rounded(layout::radius_control())
            .bg(colors::surface())
            .border_1()
            .border_color(colors::border())
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .hover(|s| {
                s.border_color(colors::control_border())
                    .bg(colors::subtle())
            })
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
                            .gap(px(6.0))
                            .child(tag_chip(scope_label(left_rule.scope_kind))),
                    )
                    .child(
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .text_size(typography::control_size())
                            .text_color(colors::ink())
                            .child(left_rule.content),
                    ),
            )
            .child(
                secondary_button(
                    format!("{prefix}-conflict-l-{idx}"),
                    l.t(CopyKey::PickThisBtn),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_action(
                        "resolve_conflict",
                        json!({ "winner_id": left_id, "loser_ids": all_ids }),
                        "已保留所选规矩，另一条已停用",
                        cx,
                    );
                })),
            )
            .into_any_element();

        let right_box = div()
            .w_full()
            .min_w(px(0.0))
            .px(px(14.0))
            .py(px(11.0))
            .rounded(layout::radius_control())
            .bg(colors::surface())
            .border_1()
            .border_color(colors::border())
            .flex()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .hover(|s| {
                s.border_color(colors::control_border())
                    .bg(colors::subtle())
            })
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
                            .gap(px(6.0))
                            .child(tag_chip(scope_label(right_rule.scope_kind))),
                    )
                    .child(
                        div()
                            .w_full()
                            .min_w(px(0.0))
                            .text_size(typography::control_size())
                            .text_color(colors::ink())
                            .child(right_rule.content),
                    ),
            )
            .child(
                secondary_button(
                    format!("{prefix}-conflict-r-{idx}"),
                    l.t(CopyKey::PickThisBtn),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_action(
                        "resolve_conflict",
                        json!({ "winner_id": right_id, "loser_ids": all_ids_r }),
                        "已保留所选规矩，另一条已停用",
                        cx,
                    );
                })),
            )
            .into_any_element();

        Some(conflict_split_card(
            format!(
                "{}: {}",
                tr(l, "规矩打架了", "Rule Conflict"),
                conflict.pref_key
            ),
            conflict.reason.clone(),
            left_box,
            right_box,
        ))
    }

    // =========================================================================
    // View 2: FULI Bot Unified Multi-Client Workbench
    // =========================================================================

    fn render_agents(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let selected_id = self
            .selected_agent_id
            .clone()
            .or_else(|| data.agents.first().map(|a| a.agent.id.clone()));

        let mut list_items = div().flex().flex_col().gap(px(8.0));
        if data.agents.is_empty() {
            list_items = list_items.child(empty_state(
                tr(l, "还没有绑定项目", "No FULI Bots yet"),
                tr(
                    l,
                    "点上方「+ 新建 FULI Bot」，或在项目目录触发一次 Hook 自动建档。",
                    "Click '+ New FULI Bot' above, or run a Hook inside any Git workspace.",
                ),
            ));
        } else {
            for (idx, card) in data.agents.iter().enumerate() {
                let aid = card.agent.id.clone();
                let is_sel = selected_id.as_deref() == Some(aid.as_str());
                let has_live_session = data
                    .sessions
                    .iter()
                    .any(|s| s.agent_id.as_deref() == Some(aid.as_str()));
                let presence = if has_live_session {
                    AvatarPresence::Online
                } else {
                    AvatarPresence::None
                };

                list_items = list_items.child(
                    div()
                        .id(format!("agent-row-{idx}"))
                        .w_full()
                        .min_w(px(0.0))
                        .px(px(12.0))
                        .py(px(10.0))
                        .rounded(layout::radius_control())
                        .border_1()
                        .border_color(if is_sel {
                            colors::ink()
                        } else {
                            colors::border()
                        })
                        .bg(if is_sel {
                            colors::subtle()
                        } else {
                            colors::surface()
                        })
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(10.0))
                        .cursor_pointer()
                        .hover(|style| {
                            style
                                .bg(colors::subtle())
                                .border_color(colors::control_border())
                        })
                        .active(|style| style.bg(colors::hover()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected_agent_id = Some(aid.clone());
                            cx.notify();
                        }))
                        .child(fuli_avatar(
                            format!("bot-list-av-{idx}"),
                            &card.agent.name,
                            AvatarSize::Sm,
                            presence,
                        ))
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(0.0))
                                .flex()
                                .flex_col()
                                .gap(px(2.0))
                                .child(
                                    div()
                                        .text_size(typography::body_size())
                                        .font_weight(typography::WEIGHT_MEDIUM)
                                        .text_color(colors::ink())
                                        .overflow_hidden()
                                        .whitespace_nowrap()
                                        .text_ellipsis()
                                        .child(card.agent.name.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(typography::meta_size())
                                        .text_color(colors::muted())
                                        .child(format!(
                                            "{} {} · {} {} · {} {}",
                                            card.bindings.len(),
                                            tr(l, "绑定", "bindings"),
                                            card.mounts.len(),
                                            tr(l, "挂载", "mounted"),
                                            card.authorized_kbs.len(),
                                            tr(l, "授权库", "KBs")
                                        )),
                                ),
                        )
                        .child(status_badge(
                            card.agent.reply_lang.clone(),
                            BadgeTone::Neutral,
                        )),
                );
            }
        }

        let list_card = section_card()
            .w(px(340.0))
            .flex_shrink_0()
            .min_h(px(0.0))
            .child(section_header(
                tr(l, "我的 FULI Bot", "My FULI Bots"),
                Some(
                    primary_button("btn-new-agent", l.t(CopyKey::NewAgentBtn), ControlSize::Sm)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_modal(ActiveModal::NewAgent, window, cx);
                        }))
                        .into_any_element(),
                ),
            ))
            .child(scroll_area("agents-list-scroll", list_items));

        let mut detail_col = div().flex().flex_col().gap(px(14.0)).pb(px(12.0));
        if let Some(ref sid) = selected_id
            && let Some(selected) = data.agents.iter().find(|a| &a.agent.id == sid)
        {
            let agent_sessions: Vec<_> = data
                .sessions
                .iter()
                .filter(|s| s.agent_id.as_deref() == Some(sid.as_str()))
                .collect();
            let mut sessions_card = section_card().child(section_header(
                format!(
                    "{} · {}",
                    selected.agent.name,
                    tr(l, "各客户端活跃会话", "Live Client Sessions")
                ),
                Some(
                    status_badge(format!("{}", agent_sessions.len()), BadgeTone::Success)
                        .into_any_element(),
                ),
            ));
            if agent_sessions.is_empty() {
                sessions_card = sessions_card.child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(tr(
                            l,
                            "Claude Code、Codex、Cursor 等客户端接入后，会在这里统一列出各自所在目录，并支持一键复制续接命令。",
                            "Connected Claude Code, Codex, and Cursor sessions appear here with 1-click resume copy.",
                        )),
                );
            } else {
                for (idx, s) in agent_sessions.iter().enumerate() {
                    let sess_key = format!("{}:{}", s.client_id, s.session_id);
                    let resume_cmd = session_resume_command(&s.client_id, &s.session_id);
                    let is_copied = self.copied_session_key.as_deref() == Some(sess_key.as_str());
                    let sk_clone = sess_key.clone();
                    sessions_card = sessions_card.child(
                        inset_panel().child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(10.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.0))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(6.0))
                                                .child(tag_chip(s.client_id.clone()))
                                                .child(
                                                    div()
                                                        .text_size(typography::control_size())
                                                        .font_weight(typography::WEIGHT_MEDIUM)
                                                        .child(s.session_id.clone()),
                                                ),
                                        )
                                        .child(
                                            div()
                                                .text_size(typography::meta_size())
                                                .text_color(colors::muted())
                                                .child(format!(
                                                    "epoch {} · {}",
                                                    s.context_epoch, s.cwd
                                                )),
                                        ),
                                )
                                .child(
                                    copy_button(
                                        format!("copy-sess-{idx}"),
                                        l.t(CopyKey::CopyResumeBtn),
                                        l.t(CopyKey::CopiedLabel),
                                        is_copied,
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                resume_cmd.clone(),
                                            ));
                                            this.copied_session_key = Some(sk_clone.clone());
                                            this.toast = Some((
                                                format!("Copied: {resume_cmd}"),
                                                BadgeTone::Success,
                                            ));
                                            cx.notify();
                                        },
                                    )),
                                ),
                        ),
                    );
                }
            }

            let agent_ws: Vec<_> = data
                .workstreams
                .iter()
                .filter(|w| &w.agent_id == sid)
                .collect();
            let mut ws_card = section_card().child(section_header(
                tr(l, "Workbench 工作线", "Workbench Workstreams"),
                Some(
                    status_badge(format!("{}", agent_ws.len()), BadgeTone::Gold).into_any_element(),
                ),
            ));
            if agent_ws.is_empty() {
                ws_card = ws_card.child(empty_state(
                    tr(l, "暂无进行中的工作线", "No active workstreams"),
                    tr(
                        l,
                        "完成阶段性目标后记录 checkpoint，换到另一台客户端就能直接无缝接着做。",
                        "Save structured checkpoints to resume cleanly across any AI client without replaying raw chats.",
                    ),
                ));
            } else {
                for ws in &agent_ws {
                    let (st_label, tone) = match ws.status {
                        WorkstreamStatus::Active => (tr(l, "进行中", "Active"), BadgeTone::Success),
                        WorkstreamStatus::Paused => (tr(l, "已暂停", "Paused"), BadgeTone::Warning),
                        WorkstreamStatus::Done => (tr(l, "已完成", "Done"), BadgeTone::Neutral),
                    };
                    ws_card = ws_card.child(
                        inset_panel().child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .text_size(typography::control_size())
                                                .font_weight(typography::WEIGHT_MEDIUM)
                                                .child(ws.title.clone()),
                                        )
                                        .child(
                                            div()
                                                .text_size(typography::meta_size())
                                                .text_color(colors::muted())
                                                .child(if ws.branch_name.is_empty() {
                                                    ws.updated_at.clone()
                                                } else {
                                                    format!(
                                                        "{} · {}",
                                                        ws.branch_name, ws.updated_at
                                                    )
                                                }),
                                        ),
                                )
                                .child(status_badge(st_label, tone)),
                        ),
                    );
                }
            }

            let agent_wfs: Vec<_> = data
                .workflows
                .iter()
                .filter(|w| &w.agent_id == sid)
                .collect();
            let mut wf_card = section_card().child(section_header(
                tr(l, "可复用工作流（Workflow）", "Reusable Workflows"),
                Some(
                    status_badge(format!("{}", agent_wfs.len()), BadgeTone::Neutral)
                        .into_any_element(),
                ),
            ));
            if agent_wfs.is_empty() {
                wf_card = wf_card.child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(tr(
                            l,
                            "重复跑通的固定流程（如双端发版检查、回归验证）可以沉淀成这个 FULI Bot 的标准工作流。",
                            "Repeated checklists (release checks, regressions) evolve into standard Workflows here.",
                        )),
                );
            } else {
                for (idx, wf) in agent_wfs.iter().enumerate() {
                    let wfid = wf.id.clone();
                    let right_el = if wf.status == WorkflowStatus::Proposed {
                        primary_button(
                            format!("wf-approve-{idx}"),
                            tr(l, "确认启用", "Enable"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.run_action(
                                "approve_workflow",
                                json!({ "id": wfid }),
                                "工作流已启用",
                                cx,
                            );
                        }))
                        .into_any_element()
                    } else {
                        status_badge(
                            format!("{}/{} pass", wf.pass_count, wf.run_count),
                            BadgeTone::Success,
                        )
                        .into_any_element()
                    };
                    wf_card = wf_card.child(
                        inset_panel().child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .child(
                                            div()
                                                .text_size(typography::control_size())
                                                .font_weight(typography::WEIGHT_MEDIUM)
                                                .child(wf.title.clone()),
                                        )
                                        .child(
                                            div()
                                                .text_size(typography::meta_size())
                                                .text_color(colors::muted())
                                                .child(wf.summary.clone()),
                                        ),
                                )
                                .child(right_el),
                        ),
                    );
                }
            }

            detail_col = detail_col
                .child(sessions_card)
                .child(ws_card)
                .child(wf_card);
        } else {
            detail_col = detail_col.child(section_card().child(empty_state(
                tr(l, "在左侧选一个 FULI Bot", "Select a FULI Bot on the left"),
                tr(
                    l,
                    "即可集中查看它绑定的仓库、所有客户端会话、工作线和工作流。",
                    "Inspect bound repositories, cross-client sessions, workstreams, and workflows in one view.",
                ),
            )));
        }

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(list_card)
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(apple_view_transition(
                        format!("agent-detail-{}", selected_id.as_deref().unwrap_or("none")),
                        scroll_area("agents-detail-scroll", detail_col).into_any_element(),
                    )),
            )
    }

    // =========================================================================
    // View 3: Memory (Knowledge + Rules)
    // =========================================================================

    fn render_memory(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let mem_idx = match self.memory_sub {
            MemorySubTab::Knowledge => 0,
            MemorySubTab::Rules => 1,
        };
        let top_bar = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(10.0))
            .child(spring_segmented_control(
                "mem-sub-spring",
                mem_idx,
                122.0,
                vec![
                    spring_segment_slot(
                        "mem-tab-kb",
                        l.t(CopyKey::TabKnowledge),
                        122.0,
                        self.memory_sub == MemorySubTab::Knowledge,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.memory_sub = MemorySubTab::Knowledge;
                        cx.notify();
                    }))
                    .into_any_element(),
                    spring_segment_slot(
                        "mem-tab-rules",
                        l.t(CopyKey::TabRules),
                        122.0,
                        self.memory_sub == MemorySubTab::Rules,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.memory_sub = MemorySubTab::Rules;
                        cx.notify();
                    }))
                    .into_any_element(),
                ],
            ))
            .child(match self.memory_sub {
                MemorySubTab::Knowledge => primary_button(
                    "btn-add-kb-item",
                    l.t(CopyKey::NewKnowledgeBtn),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.open_modal(ActiveModal::NewKnowledge, window, cx);
                })),
                MemorySubTab::Rules => {
                    primary_button("btn-add-rule", l.t(CopyKey::NewRuleBtn), ControlSize::Sm)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_modal(ActiveModal::NewRule, window, cx);
                        }))
                }
            });

        let body = match self.memory_sub {
            MemorySubTab::Knowledge => self.render_memory_knowledge(cx),
            MemorySubTab::Rules => self.render_memory_rules(cx),
        };

        div()
            .flex_1()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(top_bar)
            .child(apple_view_transition(
                format!("mem-sub-{:?}", self.memory_sub),
                body.into_any_element(),
            ))
    }

    fn render_memory_knowledge(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let selected_kb = self
            .selected_kb_id
            .clone()
            .or_else(|| data.knowledge_bases.first().map(|k| k.id.clone()));

        let mut kb_rows = div().flex().flex_col().gap(px(8.0));
        for (idx, kb) in data.knowledge_bases.iter().enumerate() {
            let kid = kb.id.clone();
            let is_sel = selected_kb.as_deref() == Some(kid.as_str());
            let count = data.kb_items.iter().filter(|i| i.kb_id == kb.id).count();
            kb_rows = kb_rows.child(
                inset_list_row(
                    format!("kb-row-{idx}"),
                    kb.name.clone(),
                    format!("{count} {} · {}", tr(l, "条", "items"), kb.default_lang),
                    is_sel,
                    None,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.selected_kb_id = Some(kid.clone());
                    this.search_result = None;
                    cx.notify();
                })),
            );
        }

        if let Some(ref cur_kb) = selected_kb {
            let other_kbs: Vec<_> = data
                .knowledge_bases
                .iter()
                .filter(|k| &k.id != cur_kb)
                .collect();
            if !other_kbs.is_empty() {
                kb_rows = kb_rows.child(divider()).child(
                    div()
                        .text_size(typography::meta_size())
                        .font_weight(typography::WEIGHT_MEDIUM)
                        .text_color(colors::muted())
                        .child(tr(
                            l,
                            "跨知识库授权引用（仅开启的库可被检索）",
                            "Cross-KB Authorization (zero leaks outside enabled links)",
                        )),
                );
                for (idx, target) in other_kbs.iter().enumerate() {
                    let is_linked = data.kb_links.iter().any(|lnk| {
                        &lnk.from_kb_id == cur_kb
                            && lnk.to_kb_id == target.id
                            && lnk.authority == LinkAuthority::HumanConfirmed
                    });
                    let from_id = cur_kb.clone();
                    let to_id = target.id.clone();
                    kb_rows = kb_rows.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.0))
                            .py(px(4.0))
                            .child(
                                div()
                                    .text_size(typography::control_size())
                                    .text_color(colors::ink())
                                    .child(target.name.clone()),
                            )
                            .child(toggle_switch(
                                format!("kb-link-sw-{idx}"),
                                is_linked,
                                cx.listener(move |this, next_checked: &bool, _, cx| {
                                    this.run_action(
                                        "toggle_kb_link",
                                        json!({
                                            "from_kb_id": from_id,
                                            "to_kb_id": to_id,
                                            "enable": *next_checked
                                        }),
                                        if *next_checked {
                                            "已授权跨库引用（检索自动生效）"
                                        } else {
                                            "已撤销该跨库授权（立刻隔离）"
                                        },
                                        cx,
                                    );
                                }),
                            )),
                    );
                }
            }
        }

        let kb_list_card = section_card()
            .w(px(310.0))
            .min_h(px(0.0))
            .child(section_header(
                tr(l, "知识库与跨库授权", "Knowledge Bases"),
                Some(
                    status_badge(
                        format!("{}", data.knowledge_bases.len()),
                        BadgeTone::Neutral,
                    )
                    .into_any_element(),
                ),
            ))
            .child(scroll_area("kb-list-scroll", kb_rows));

        let search_extra = if self.search_result.is_some() {
            Some(
                secondary_button("btn-clear-search", l.t(CopyKey::ClearBtn), ControlSize::Md)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.clear_search(window, cx);
                    }))
                    .into_any_element(),
            )
        } else {
            Some(kbd_chip("Enter").into_any_element())
        };

        // Status filter pills when browsing
        let filter_row = div()
            .flex()
            .items_center()
            .gap(px(6.0))
            .child(
                segmented_tab(
                    "kbf-all",
                    tr(l, "全部", "All"),
                    self.kb_filter == KbFilter::All,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.kb_filter = KbFilter::All;
                    cx.notify();
                })),
            )
            .child(
                segmented_tab(
                    "kbf-prop",
                    tr(l, "待确认", "Proposals"),
                    self.kb_filter == KbFilter::Proposal,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.kb_filter = KbFilter::Proposal;
                    cx.notify();
                })),
            )
            .child(
                segmented_tab(
                    "kbf-conf",
                    tr(l, "已生效", "Confirmed"),
                    self.kb_filter == KbFilter::Confirmed,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.kb_filter = KbFilter::Confirmed;
                    cx.notify();
                })),
            )
            .child(
                segmented_tab(
                    "kbf-dep",
                    tr(l, "已废弃", "Deprecated"),
                    self.kb_filter == KbFilter::Deprecated,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.kb_filter = KbFilter::Deprecated;
                    cx.notify();
                })),
            );

        let mut list_content = div().flex().flex_col().gap(px(10.0)).pb(px(12.0));

        if let Some(ref sr) = self.search_result {
            list_content = list_content.child(notice_banner(
                BadgeTone::Gold,
                format!(
                    "「{}」· {}/{} ({} KBs)",
                    sr.query, sr.budget.returned, sr.budget.total_matched, sr.authorized_kb_count
                ),
                format!(
                    "Budget: {}/{} B · {}",
                    sr.budget.used_bytes,
                    sr.budget.limit_bytes,
                    if sr.budget.complete {
                        tr(l, "已完整返回", "Complete")
                    } else {
                        tr(l, "已按最高分截断", "Score-trimmed")
                    }
                ),
            ));
            if sr.hits.is_empty() {
                list_content = list_content.child(empty_state(
                    tr(l, "没有搜到匹配条目", "No matching items"),
                    tr(
                        l,
                        "换一个中文或英文关键词试试，或者检查左侧跨库授权开关是否已打开。",
                        "Try another CN/EN term, or enable cross-KB authorization on the left.",
                    ),
                ));
            } else {
                for (idx, hit) in sr.hits.iter().enumerate() {
                    let hid = hit.id.clone();
                    list_content = list_content.child(
                        inset_panel()
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
                                            .gap(px(6.0))
                                            .child(
                                                div()
                                                    .text_size(typography::body_size())
                                                    .font_weight(typography::WEIGHT_MEDIUM)
                                                    .child(format!("{} (v{})", hit.title, hit.rev)),
                                            )
                                            .child(tag_chip(format!(
                                                "{} · hop {}",
                                                hit.kb_name, hit.hop
                                            ))),
                                    )
                                    .child(status_badge(
                                        format!("{:.2}", hit.score),
                                        if hit.needs_review {
                                            BadgeTone::Danger
                                        } else {
                                            BadgeTone::Success
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child(hit.body.chars().take(180).collect::<String>()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .child(tag_chip(hit.item_type.as_str().to_string()))
                                    .child(
                                        secondary_button(
                                            format!("hit-ver-{idx}"),
                                            l.t(CopyKey::HistoryBtn),
                                            ControlSize::Sm,
                                        )
                                        .on_click(
                                            cx.listener(move |this, _, _, cx| {
                                                this.open_item_drawer(&hid, cx);
                                            }),
                                        ),
                                    ),
                            ),
                    );
                }
            }
        } else {
            let filtered: Vec<_> = data
                .kb_items
                .iter()
                .filter(|i| selected_kb.as_deref().is_none_or(|k| i.kb_id == k))
                .filter(|i| match self.kb_filter {
                    KbFilter::All => true,
                    KbFilter::Proposal => i.status == KbItemStatus::Proposal,
                    KbFilter::Confirmed => i.status == KbItemStatus::Confirmed,
                    KbFilter::Deprecated => i.status == KbItemStatus::Deprecated,
                })
                .collect();
            if filtered.is_empty() {
                list_content = list_content.child(empty_state(
                    tr(l, "这个视图下还没有条目", "No items in this view"),
                    tr(
                        l,
                        "点右上角「+ 记一条知识」，或在日常协作中沉淀经验，旧版本永不覆盖丢失。",
                        "Click '+ Add Knowledge' above to capture a versioned fact or runbook.",
                    ),
                ));
            } else {
                for (idx, item) in filtered.iter().enumerate() {
                    let id_help = item.id.clone();
                    let id_stale = item.id.clone();
                    let id_ver = item.id.clone();
                    let (st_label, tone) = match (item.status, item.needs_review) {
                        (KbItemStatus::Deprecated, _) => {
                            (tr(l, "已废弃", "Deprecated"), BadgeTone::Neutral)
                        }
                        (KbItemStatus::Proposal, _) => {
                            (tr(l, "待确认", "Proposal"), BadgeTone::Warning)
                        }
                        (_, true) => (tr(l, "可能过时", "Needs Review"), BadgeTone::Danger),
                        _ => (tr(l, "已生效", "Confirmed"), BadgeTone::Success),
                    };
                    list_content = list_content.child(
                        inset_panel()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_size(typography::body_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .child(format!("{} (v{})", item.title, item.revision)),
                                    )
                                    .child(status_badge(st_label, tone)),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child(item.body.chars().take(160).collect::<String>()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::muted())
                                            .child(format!(
                                                "{} {} · {} {}",
                                                tr(l, "复用", "Reused"),
                                                item.reuse_count,
                                                tr(l, "有用", "Helpful"),
                                                item.helpful_count
                                            )),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .gap(px(6.0))
                                            .child(
                                                secondary_button(
                                                    format!("kb-ver-{idx}"),
                                                    l.t(CopyKey::HistoryBtn),
                                                    ControlSize::Sm,
                                                )
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.open_item_drawer(&id_ver, cx);
                                                })),
                                            )
                                            .child(
                                                secondary_button(
                                                    format!("kb-helpful-{idx}"),
                                                    l.t(CopyKey::HelpfulBtn),
                                                    ControlSize::Sm,
                                                )
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.run_action(
                                                        "feedback_kb_item",
                                                        json!({ "id": id_help, "feedback": "helpful" }),
                                                        "已记下正向复利，之后检索会优先推荐这条",
                                                        cx,
                                                    );
                                                })),
                                            )
                                            .child(
                                                secondary_button(
                                                    format!("kb-stale-{idx}"),
                                                    l.t(CopyKey::StaleBtn),
                                                    ControlSize::Sm,
                                                )
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.run_action(
                                                        "feedback_kb_item",
                                                        json!({ "id": id_stale, "feedback": "stale" }),
                                                        "已标为可能过时，检索时将自动降权 70%",
                                                        cx,
                                                    );
                                                })),
                                            ),
                                    ),
                            ),
                    );
                }
            }
        }

        let items_card = section_card()
            .flex_1()
            .min_h(px(0.0))
            .child(search_bar(
                &self.search_input,
                primary_button("btn-run-search", l.t(CopyKey::SearchBtn), ControlSize::Md)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.execute_search(cx);
                    }))
                    .into_any_element(),
                search_extra,
            ))
            .child(filter_row)
            .child(scroll_area("kb-items-scroll", list_content));

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(kb_list_card)
            .child(items_card)
    }

    fn render_memory_rules(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let personal: Vec<_> = data
            .rules
            .iter()
            .filter(|r| {
                r.scope_kind == RuleScope::PersonalGlobal && r.status != RuleStatus::Disabled
            })
            .collect();
        let project: Vec<_> = data
            .rules
            .iter()
            .filter(|r| r.scope_kind == RuleScope::Agent && r.status != RuleStatus::Disabled)
            .collect();

        let render_col = |title: &str,
                          subtitle: &str,
                          list: Vec<&fuli_domain::RuleOrPref>,
                          prefix: &str,
                          scroll_id: &str,
                          cx: &mut Context<Self>| {
            let mut rows = div().flex().flex_col().gap(px(8.0)).pb(px(12.0));
            if list.is_empty() {
                rows = rows.child(empty_state(
                    tr(
                        l,
                        "暂时没有记下规矩或偏好",
                        "No active rules or preferences",
                    ),
                    tr(
                        l,
                        "点右上角「+ 定一条规矩」，或在对话里说「记住以后都……」就会记到这里。",
                        "Click '+ Add Rule' above, or state an explicit rule in any AI client.",
                    ),
                ));
            } else {
                for (idx, rule) in list.into_iter().enumerate() {
                    let rid = rule.id.clone();
                    let (badge, tone) = match rule.constraint_class {
                        ConstraintClass::HardRule => {
                            (tr(l, "红线规矩", "Hard Rule"), BadgeTone::Danger)
                        }
                        ConstraintClass::Preference => {
                            (tr(l, "日常偏好", "Preference"), BadgeTone::Gold)
                        }
                    };
                    let mut tags = div()
                        .flex()
                        .items_center()
                        .flex_wrap()
                        .gap(px(6.0))
                        .child(status_badge(badge, tone))
                        .child(tag_chip(rule.pref_key.clone()));
                    for wk in &rule.applicability.work_kinds {
                        tags = tags.child(tag_chip(wk.clone()));
                    }
                    rows = rows.child(
                        inset_panel().child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .gap(px(10.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.0))
                                        .child(tags)
                                        .child(
                                            div()
                                                .text_size(typography::body_size())
                                                .child(rule.content.clone()),
                                        ),
                                )
                                .child(
                                    secondary_button(
                                        format!("{prefix}-off-{idx}"),
                                        tr(l, "撤回", "Undo"),
                                        ControlSize::Sm,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _, _, cx| {
                                            this.run_action(
                                                "disable_rule",
                                                json!({ "id": rid }),
                                                "已一键撤回该条规矩/偏好",
                                                cx,
                                            );
                                        },
                                    )),
                                ),
                        ),
                    );
                }
            }
            section_card()
                .flex_1()
                .min_h(px(0.0))
                .child(section_header(title.to_string(), None))
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(subtitle.to_string()),
                )
                .child(scroll_area(scroll_id.to_string(), rows))
        };

        let mut container = div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .gap(px(12.0));
        for (idx, conflict) in data.rule_conflicts.iter().take(2).enumerate() {
            if let Some(card) = self.render_conflict_card("rules", idx, conflict, cx) {
                container = container.child(card);
            }
        }
        container.child(
            div()
                .flex_1()
                .min_h(px(0.0))
                .flex()
                .gap(px(18.0))
                .child(render_col(
                    tr(
                        l,
                        "个人通用习惯（全项目生效）",
                        "Personal Global Preferences",
                    ),
                    tr(
                        l,
                        "你的个人表达风格、排版审美、判断口味，切换任意项目都跟着你走。",
                        "Follows you across every workspace and AI client.",
                    ),
                    personal,
                    "personal",
                    "rules-personal-scroll",
                    cx,
                ))
                .child(render_col(
                    tr(l, "当前项目规矩（按项目隔离）", "Project-Specific Rules"),
                    tr(
                        l,
                        "特定仓库的架构红线、分支规范、技术选型，绝不串台污染别的项目。",
                        "Isolated per FULI Bot — never leaks across repositories.",
                    ),
                    project,
                    "project",
                    "rules-project-scroll",
                    cx,
                )),
        )
    }

    // =========================================================================
    // View 4: Roundtable
    // =========================================================================

    fn render_roundtable(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let mut rows = div().flex().flex_col().gap(px(10.0)).pb(px(12.0));

        if data.roundtable.is_empty() {
            rows = rows.child(empty_state(
                tr(l, "还没有跨客户端问询记录", "No Roundtable exchanges yet"),
                tr(
                    l,
                    "点右上角「+ 发起跨客户端问询」，或由 Codex / Claude Code 调用 ask_agent 发起只读问询，零局域网广播开销。",
                    "Click '+ Ask Session' above or call ask_agent from any AI client (native session_id wake or clean inbox fallback).",
                ),
            ));
        } else {
            for ex in &data.roundtable {
                let (st, tone) = match ex.wake_status {
                    WakeStatus::WokenReplied => (tr(l, "已回复", "Replied"), BadgeTone::Success),
                    WakeStatus::QueuedInbox => {
                        (tr(l, "待对方读取", "In Inbox"), BadgeTone::Warning)
                    }
                    WakeStatus::Failed => (tr(l, "唤起失败", "Failed"), BadgeTone::Danger),
                };
                rows = rows.child(
                    inset_panel()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .child(
                                    div()
                                        .text_size(typography::control_size())
                                        .font_weight(typography::WEIGHT_MEDIUM)
                                        .child(format!(
                                            "{} ({}) → {} ({})",
                                            ex.from_client,
                                            ex.from_session_id,
                                            ex.to_client,
                                            ex.to_session_id
                                        )),
                                )
                                .child(status_badge(st, tone)),
                        )
                        .child(
                            div()
                                .text_size(typography::body_size())
                                .child(format!("Q: {}", ex.question)),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(match &ex.answer {
                                    Some(ans) => format!("A: {ans}"),
                                    None => tr(
                                        l,
                                        "等待对方下一轮对话自动读取回复",
                                        "Waiting for target session to pick up on next turn",
                                    )
                                    .to_string(),
                                }),
                        ),
                );
            }
        }

        div().flex_1().min_h(px(0.0)).flex().child(
            section_card()
                .flex_1()
                .min_h(px(0.0))
                .child(section_header(
                    tr(l, "轻量圆桌（跨客户端点名问询）", "Lightweight Roundtable"),
                    Some(
                        primary_button(
                            "btn-rt-ask",
                            tr(l, "+ 发起跨客户端问询", "+ Ask Session"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.open_modal(ActiveModal::AskRoundtable, window, cx);
                        }))
                        .into_any_element(),
                    ),
                ))
                .child(scroll_area("roundtable-scroll", rows)),
        )
    }

    // =========================================================================
    // View 6: Settings (v0.27.16 Left Sidebar + Right Clean White Card + Audit)
    // =========================================================================

    fn render_settings(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let auto = data.autonomy_level;
        let mem_ratio = (self.status.daemon_mem.working_set_mib() / 25.0) as f32;

        // Left fixed category sidebar (matching v0.27.16 screenshot, sitting cleanly above bottom-left Dock)
        let left_sidebar = div()
            .w(px(210.0))
            .min_h(px(0.0))
            .pb(px(66.0))
            .flex()
            .flex_col()
            .justify_between()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .px(px(12.0))
                            .pb(px(4.0))
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_STRONG)
                            .text_color(colors::ink())
                            .child(tr(l, "连接与记录", "Clients & Capture")),
                    )
                    .child(
                        sidebar_nav_item(
                            "set-nav-clients",
                            tr(l, "AI 客户端接入", "AI Clients"),
                            self.settings_sub == SettingsSubTab::Clients,
                            true,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settings_sub = SettingsSubTab::Clients;
                            cx.notify();
                        })),
                    )
                    .child(
                        sidebar_nav_item(
                            "set-nav-general",
                            tr(l, "自主级别与整理", "Autonomy & Tidy"),
                            self.settings_sub == SettingsSubTab::General,
                            true,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settings_sub = SettingsSubTab::General;
                            cx.notify();
                        })),
                    )
                    .child(
                        div()
                            .px(px(12.0))
                            .pt(px(12.0))
                            .pb(px(4.0))
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_STRONG)
                            .text_color(colors::ink())
                            .child(tr(l, "透明账单与系统", "Transparency & System")),
                    )
                    .child(
                        sidebar_nav_item(
                            "set-nav-audit",
                            l.t(CopyKey::NavInspector),
                            self.settings_sub == SettingsSubTab::Audit,
                            true,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settings_sub = SettingsSubTab::Audit;
                            cx.notify();
                        })),
                    )
                    .child(
                        sidebar_nav_item(
                            "set-nav-system",
                            tr(l, "本机资源与备份", "Resources & Backup"),
                            self.settings_sub == SettingsSubTab::System,
                            true,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.settings_sub = SettingsSubTab::System;
                            cx.notify();
                        })),
                    ),
            )
            .child(
                div()
                    .p(px(4.0))
                    .rounded(layout::radius_control())
                    .bg(colors::subtle())
                    .border_1()
                    .border_color(colors::border())
                    .flex()
                    .gap(px(4.0))
                    .child(
                        segmented_tab("set-lang-zh", "中文", l == Locale::ZhCn)
                            .flex_1()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.run_action(
                                    "set_locale",
                                    json!({ "locale": "zh-CN" }),
                                    "已切换为中文界面",
                                    cx,
                                );
                            })),
                    )
                    .child(
                        segmented_tab("set-lang-en", "EN", l == Locale::EnUs)
                            .flex_1()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.run_action(
                                    "set_locale",
                                    json!({ "locale": "en-US" }),
                                    "Switched to English",
                                    cx,
                                );
                            })),
                    ),
            );

        // Right scrollable settings content card
        let right_content = match self.settings_sub {
            SettingsSubTab::Clients => {
                let mut card = section_card()
                    .child(section_header(
                        tr(l, "AI 客户端自动接入", "Connected AI Clients"),
                        Some(
                            status_badge(
                                tr(l, "改写前自动备份 .fuli.bak", "Auto-backup before write"),
                                BadgeTone::Neutral,
                            )
                            .into_any_element(),
                        ),
                    ))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "拨动开关即可为对应客户端配置或安全移除 FULI；关闭后你已攒下的记忆依然完好保留。",
                                "Toggle any client to safely connect or disconnect FULI without touching your other settings.",
                            )),
                    );

                for (idx, cl) in data.clients.iter().enumerate() {
                    let cid_on = cl.client.clone();
                    let cid_off = cl.client.clone();
                    let status_sub = format!(
                        "{} · {} · {}",
                        if cl.fuli_configured {
                            tr(l, "已接入", "Connected")
                        } else if cl.config_dir_exists {
                            tr(
                                l,
                                "已检测到，点击右侧开关接入",
                                "Detected — flip switch to connect",
                            )
                        } else {
                            tr(l, "本机未检测到配置目录", "Not installed yet")
                        },
                        if cl.supports_hooks {
                            "Hook + MCP"
                        } else {
                            "MCP"
                        },
                        cl.config_path
                    );

                    card = card.child(setting_toggle_row(
                        format!("set-cl-sw-{idx}"),
                        cl.display_name.clone(),
                        status_sub,
                        cl.fuli_configured,
                        cx.listener(move |this, checked: &bool, _, cx| {
                            if *checked {
                                this.run_action(
                                    "setup_client",
                                    json!({ "client": cid_on }),
                                    "已写入 FULI 配置并备份原文件（重启对应客户端生效）",
                                    cx,
                                );
                            } else {
                                this.run_action(
                                    "remove_client",
                                    json!({ "client": cid_off }),
                                    "已安全移除 FULI 配置，原其他配置完好",
                                    cx,
                                );
                            }
                        }),
                    ));
                }
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .pb(px(16.0))
                    .child(card)
            }
            SettingsSubTab::General => {
                let card = section_card()
                    .child(section_header(l.t(CopyKey::AutonomyTitle), None))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "不管选哪一档，红线规矩冲突和删除操作永远先问你，任何自动操作都支持一键撤回。",
                                "Hard-rule conflicts and destructive changes always ask you first; routine updates are 1-click undoable.",
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(8.0))
                            .child(
                                segmented_tab(
                                    "auto-manual",
                                    l.t(CopyKey::AutonomyManual),
                                    auto == AutonomyLevel::Manual,
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.run_action(
                                        "set_autonomy_level",
                                        json!({ "level": "manual" }),
                                        "已切为：每次都问我",
                                        cx,
                                    );
                                })),
                            )
                            .child(
                                segmented_tab(
                                    "auto-assist",
                                    l.t(CopyKey::AutonomyAssist),
                                    auto == AutonomyLevel::Assist,
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.run_action(
                                        "set_autonomy_level",
                                        json!({ "level": "assist" }),
                                        "已切为：给建议，我一键定",
                                        cx,
                                    );
                                })),
                            )
                            .child(
                                segmented_tab(
                                    "auto-routine",
                                    l.t(CopyKey::AutonomyAuto),
                                    auto == AutonomyLevel::AutoRoutine,
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.run_action(
                                        "set_autonomy_level",
                                        json!({ "level": "auto_routine" }),
                                        "已切为：常规事实自动记下（随时可撤回）",
                                        cx,
                                    );
                                })),
                            ),
                    )
                    .child(divider())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.0))
                                    .child(
                                        div()
                                            .text_size(typography::body_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .child(tr(l, "定期知识体检（Dreaming）", "Periodic Tidy (Dreaming)")),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::muted())
                                            .child(tr(
                                                l,
                                                "每 6 小时零模型费自动扫一遍重复条目、过时知识和规矩冲突。",
                                                "Zero-LLM background scan every 6h for duplicates, stale items & conflicts.",
                                            )),
                                    ),
                            )
                            .child(
                                secondary_button(
                                    "set-run-dreaming",
                                    l.t(CopyKey::DreamingRunBtn),
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.run_action(
                                        "run_dreaming",
                                        json!({}),
                                        "已完成本地零模型整理扫描",
                                        cx,
                                    );
                                })),
                            ),
                    );
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .pb(px(16.0))
                    .child(card)
            }
            SettingsSubTab::Audit => {
                // Plain human language replacement for the old confusing "透视镜"
                let delivered_count = data
                    .deliveries
                    .iter()
                    .filter(|d| d.delivery_mode == DeliveryMode::Full)
                    .count();
                let dedup_count = data
                    .deliveries
                    .iter()
                    .filter(|d| d.delivery_mode == DeliveryMode::SkippedDedup)
                    .count();

                let mut card = section_card()
                    .child(section_header(
                        tr(l, "AI 收到过什么（透明记录）", "What FULI Shared with AI"),
                        Some(
                            status_badge(
                                format!("~{} {}", data.tokens_saved, tr(l, "字已省下", "tokens saved")),
                                BadgeTone::Success,
                            )
                            .into_any_element(),
                        ),
                    ))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "你每次跟 AI 对话时，FULI 只会带上当前项目用得着的规矩和经验；同一轮已经说过的会自动跳过，不重复灌水。",
                                "On each turn, FULI shares only relevant rules & knowledge and skips anything already sent in the same conversation.",
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(10.0))
                            .child(stat_tile(
                                delivered_count.to_string(),
                                tr(l, "次带上记忆", "Context Shared"),
                                tr(l, "精准带给 AI 的次数", "Sent to AI clients"),
                            ))
                            .child(stat_tile(
                                dedup_count.to_string(),
                                tr(l, "次拦截重复", "Duplicates Skipped"),
                                tr(l, "同一轮不重复发", "Zero repeated noise"),
                            ))
                            .child(stat_tile(
                                format!("~{}", data.tokens_saved),
                                tr(l, "估算省下字数", "Tokens Saved"),
                                tr(l, "少花 Token 更聚焦", "Leaner prompts"),
                            )),
                    );

                if data.deliveries.is_empty() {
                    card = card.child(empty_state(
                        tr(l, "今天还没有 AI 来取过记忆", "No AI lookups recorded yet"),
                        tr(
                            l,
                            "在左侧「AI 客户端接入」连上 Claude Code / Codex 后，每次对话自动带上你的习惯时都会记在这里，完全透明可查。",
                            "Once connected to Claude Code or Codex, every rule or memory shared with your AI appears here in plain language.",
                        ),
                    ));
                } else {
                    for rec in &data.deliveries {
                        let (summary, tone) = match rec.delivery_mode {
                            DeliveryMode::Full => (
                                format!(
                                    "{} · {}（约 {} 字）",
                                    rec.client_id,
                                    tr(l, "完整带上了你的习惯/知识", "Shared your rule/memory"),
                                    rec.tokens_est
                                ),
                                BadgeTone::Gold,
                            ),
                            DeliveryMode::SkippedDedup => (
                                format!(
                                    "{} · {}（省下约 {} 字）",
                                    rec.client_id,
                                    tr(l, "本轮已说过，自动跳过", "Already sent — skipped"),
                                    rec.tokens_est
                                ),
                                BadgeTone::Success,
                            ),
                            DeliveryMode::DeltaRemoved => (
                                format!(
                                    "{} · {}",
                                    rec.client_id,
                                    tr(
                                        l,
                                        "已通知 AI 这条旧规矩作废",
                                        "Notified AI rule was removed"
                                    )
                                ),
                                BadgeTone::Warning,
                            ),
                            DeliveryMode::TitleOnly => (
                                format!(
                                    "{} · {}",
                                    rec.client_id,
                                    tr(l, "只给了目录标题（省字模式）", "Sent title index only")
                                ),
                                BadgeTone::Neutral,
                            ),
                            DeliveryMode::TruncatedBudget => (
                                format!(
                                    "{} · {}",
                                    rec.client_id,
                                    tr(l, "超出长度预算，已自动精简", "Trimmed to fit budget")
                                ),
                                BadgeTone::Neutral,
                            ),
                        };

                        card = card.child(
                            inset_panel().child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(10.0))
                                    .child(
                                        div()
                                            .flex_1()
                                            .flex()
                                            .flex_col()
                                            .gap(px(2.0))
                                            .child(
                                                div()
                                                    .text_size(typography::control_size())
                                                    .font_weight(typography::WEIGHT_MEDIUM)
                                                    .child(summary),
                                            )
                                            .child(
                                                div()
                                                    .text_size(typography::meta_size())
                                                    .text_color(colors::muted())
                                                    .child(rec.reason.clone()),
                                            ),
                                    )
                                    .child(status_badge(format!("第 {} 轮", rec.turn_seq), tone)),
                            ),
                        );
                    }
                }

                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .pb(px(16.0))
                    .child(card)
            }
            SettingsSubTab::System => {
                let brand_card = section_card().child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(12.0))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(14.0))
                                .child(fuli_app_icon(44.0))
                                .child(
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.0))
                                        .child(
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap(px(8.0))
                                                .child(fuli_wordmark_en(16.0))
                                                .child(fuli_wordmark_zh(16.0)),
                                        )
                                        .child(
                                            div()
                                                .text_size(typography::meta_size())
                                                .text_color(colors::muted())
                                                .child(l.t(CopyKey::Tagline)),
                                        ),
                                ),
                        )
                        .child(fuli_loading(
                            "set-brand-load",
                            LoadingSize::Compact,
                            tr(l, "纯 Rust 本地引擎运行中", "Pure Rust local engine live"),
                        )),
                );

                let telemetry_card = section_card()
                    .child(section_header(
                        tr(
                            l,
                            "本机资源占用与一键备份",
                            "Local Telemetry & Portable Backup",
                        ),
                        None,
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .flex()
                                    .justify_between()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child(tr(
                                        l,
                                        "后台常驻内存水位（目标 < 25.0 MiB）",
                                        "Daemon RAM vs 25 MiB target",
                                    ))
                                    .child(format!(
                                        "{:.2} / 25.0 MiB",
                                        self.status.daemon_mem.working_set_mib()
                                    )),
                            )
                            .child(progress_bar_animated(
                                "sys-ram-spring-bar",
                                mem_ratio,
                                if mem_ratio < 0.8 {
                                    colors::success()
                                } else {
                                    colors::warning()
                                },
                            )),
                    )
                    .child(kv_row(
                        "fuli-context",
                        if self.status.connected {
                            format!(
                                "{:.2} MiB 工作集 / {:.2} MiB 私有 (PID {})",
                                self.status.daemon_mem.working_set_mib(),
                                self.status.daemon_mem.private_mib(),
                                self.status.daemon_pid.unwrap_or(0)
                            )
                        } else {
                            self.status.note.clone()
                        },
                    ))
                    .child(kv_row(
                        "fuli-ui",
                        format!(
                            "{:.2} MiB ({} {}s -> exit 0)",
                            self.status.ui_mem.working_set_mib(),
                            tr(l, "关窗宽限", "close grace"),
                            self.close_grace_secs
                        ),
                    ))
                    .child(kv_row(
                        tr(
                            l,
                            "向量缓存（闲置 60s 自动卸载）",
                            "Vector Cache (60s idle auto-unload)",
                        ),
                        if data.vector_cache.loaded {
                            format!(
                                "{} vectors ({} B)",
                                data.vector_cache.vector_count, data.vector_cache.approx_bytes
                            )
                        } else {
                            tr(l, "未加载（0 B 占用）", "Unloaded (0 B)").into()
                        },
                    ))
                    .child(kv_row(
                        tr(l, "本地 IPC 与运行时长", "Local IPC & Uptime"),
                        format!(
                            "{:.2} ms · {}s",
                            self.status.ipc_rtt_ms, self.status.uptime_secs
                        ),
                    ))
                    .child(kv_row(
                        tr(l, "唯一本地数据库", "SQLite WAL Database"),
                        self.status.db_path.clone(),
                    ))
                    .child(
                        div()
                            .pt(px(8.0))
                            .flex()
                            .flex_wrap()
                            .gap(px(8.0))
                            .child(
                                primary_button(
                                    "btn-export-json",
                                    tr(l, "导出便携 JSON 备份", "Export Portable JSON"),
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        match dispatch_ui_action(
                                            &this.endpoint,
                                            "export_to_file",
                                            json!({}),
                                        ) {
                                            Ok(val) => {
                                                let path =
                                                    val["path"].as_str().unwrap_or("").to_string();
                                                cx.write_to_clipboard(ClipboardItem::new_string(
                                                    path.clone(),
                                                ));
                                                this.toast = Some((
                                                    format!("已导出纯净备份并复制路径：{path}"),
                                                    BadgeTone::Success,
                                                ));
                                            }
                                            Err(err) => {
                                                this.toast = Some((
                                                    format!("导出失败：{err}"),
                                                    BadgeTone::Danger,
                                                ));
                                            }
                                        }
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "btn-close-free",
                                    l.t(CopyKey::CloseAndFreeBtn),
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        let _ = send_request(
                                            &this.endpoint,
                                            &IpcRequest::NotifyUiClosing { grace_secs: 0 },
                                        );
                                        cx.quit();
                                    },
                                )),
                            ),
                    );

                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.0))
                    .pb(px(16.0))
                    .child(brand_card)
                    .child(telemetry_card)
            }
        };

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(left_sidebar)
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(apple_view_transition(
                        format!("settings-sub-{:?}", self.settings_sub),
                        scroll_area("settings-right-scroll", right_content).into_any_element(),
                    )),
            )
    }

    // =========================================================================
    // Overlays: Right Version-History Drawer & Centered Create Modals
    // =========================================================================

    fn render_detail_drawer(&self, detail: &ItemDetailData, cx: &mut Context<Self>) -> AnyElement {
        let l = self.locale();
        let item = &detail.item;
        let id_confirm = item.id.clone();
        let id_promote = item.id.clone();
        let id_dep = item.id.clone();
        let agent_for_promote = self.selected_agent_id.clone();

        let mut alias_row = div().flex().flex_wrap().gap(px(6.0));
        for a in &item.aliases {
            alias_row = alias_row.child(tag_chip(a.clone()));
        }

        let mut action_bar = div().flex().flex_wrap().gap(px(8.0));
        if item.status == KbItemStatus::Proposal {
            action_bar = action_bar.child(
                primary_button("dr-confirm", l.t(CopyKey::ConfirmBtn), ControlSize::Sm).on_click(
                    cx.listener(move |this, _, _, cx| {
                        this.run_action(
                            "confirm_kb_item",
                            json!({ "id": id_confirm }),
                            "已确认入库",
                            cx,
                        );
                        this.detail_item = None;
                    }),
                ),
            );
        }
        action_bar = action_bar
            .child(
                secondary_button("dr-promote", l.t(CopyKey::PromoteHardBtn), ControlSize::Sm)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.run_action(
                            "promote_kb_to_hard_rule",
                            json!({ "id": id_promote, "agent_id": agent_for_promote }),
                            "已一键升格为红线规矩，可在「记忆 · 偏好」查看",
                            cx,
                        );
                    })),
            )
            .child(
                danger_button(
                    "dr-deprecate",
                    tr(l, "废弃条目", "Deprecate"),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_action(
                        "deprecate_kb_item",
                        json!({ "id": id_dep }),
                        "已废弃（历史版本依然保留）",
                        cx,
                    );
                    this.detail_item = None;
                })),
            );

        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(action_bar)
            .child(
                inset_panel()
                    .child(
                        div()
                            .text_size(typography::control_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .child(tr(l, "当前生效内容", "Current Content")),
                    )
                    .child(
                        div()
                            .text_size(typography::body_size())
                            .child(item.body.clone()),
                    )
                    .child(alias_row),
            )
            .child(
                div()
                    .text_size(typography::control_size())
                    .font_weight(typography::WEIGHT_STRONG)
                    .child(format!(
                        "{} ({})",
                        tr(
                            l,
                            "版本演化历史（旧版永不丢失）",
                            "Version History (Immutable)"
                        ),
                        detail.versions.len()
                    )),
            );

        for ver in &detail.versions {
            content = content.child(notice_banner(
                if ver.revision == item.revision {
                    BadgeTone::Success
                } else {
                    BadgeTone::Neutral
                },
                format!("v{} · {} ({})", ver.revision, ver.title, ver.created_at),
                format!("{} · {}", ver.body, ver.change_reason),
            ));
        }

        detail_drawer(
            item.title.clone(),
            format!(
                "v{} · {} {} · {} {}",
                item.revision,
                tr(l, "复用", "Reused"),
                item.reuse_count,
                tr(l, "有用", "Helpful"),
                item.helpful_count
            ),
            secondary_button("drawer-close", l.t(CopyKey::CloseBtn), ControlSize::Sm)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.detail_item = None;
                    cx.notify();
                }))
                .into_any_element(),
            scroll_area("drawer-versions-scroll", content).into_any_element(),
        )
    }

    fn render_active_modal(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let l = self.locale();
        if self.active_modal == ActiveModal::None {
            return None;
        }

        let (title, subtitle, body) = match self.active_modal {
            ActiveModal::None => unreachable!(),
            ActiveModal::NewAgent => (
                tr(l, "新建 FULI Bot 档案", "New FULI Bot"),
                tr(
                    l,
                    "自动配好专属知识库，并可绑定本地目录或 Git 仓库地址（支持多 worktree 自动归属）。",
                    "Creates a primary KB and binds an optional directory or Git remote (unifies all worktrees).",
                ),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(form_field(
                        tr(l, "项目名称", "Project Name"),
                        None,
                        text_input(&self.form_title, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "一句话说明", "Short Description"),
                        None,
                        text_input(&self.form_body, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(
                            l,
                            "绑定目录或 Git 远程地址（可选）",
                            "Directory or Git Remote (optional)",
                        ),
                        Some("e.g. t:/workspace/my-app or git@github.com:user/repo.git".into()),
                        text_input(&self.form_extra, ControlSize::Md).into_any_element(),
                    ))
                    .into_any_element(),
            ),
            ActiveModal::NewKnowledge => (
                tr(l, "记一条知识（永久版本留痕）", "Add Versioned Knowledge"),
                tr(
                    l,
                    "直接确认存入当前选中的知识库，立即支持中英双语检索。",
                    "Saved as confirmed into the selected KB with immediate bilingual FTS5 indexing.",
                ),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(form_field(
                        tr(l, "标题", "Title"),
                        None,
                        text_input(&self.form_title, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "内容 / 避坑做法", "Body / Takeaway"),
                        None,
                        text_input(&self.form_body, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(
                            l,
                            "检索别名 / 英文关键词（逗号分隔，可选）",
                            "Search Aliases (comma-separated)",
                        ),
                        Some("e.g. release runbook, 上线步骤".into()),
                        text_input(&self.form_extra, ControlSize::Md).into_any_element(),
                    ))
                    .into_any_element(),
            ),
            ActiveModal::NewRule => (
                tr(l, "定一条规矩或习惯", "Add Rule or Preference"),
                tr(
                    l,
                    "明确写下的规矩立即生效，软偏好永远盖不住红线规矩，随时可一键撤回。",
                    "Explicit rules take effect immediately; preferences never override hard rules.",
                ),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                segmented_tab(
                                    "m-scope-global",
                                    tr(l, "个人全局", "Personal Global"),
                                    self.rule_scope == RuleScope::PersonalGlobal,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.rule_scope = RuleScope::PersonalGlobal;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                segmented_tab(
                                    "m-scope-agent",
                                    tr(l, "当前项目", "Project"),
                                    self.rule_scope == RuleScope::Agent,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.rule_scope = RuleScope::Agent;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                segmented_tab(
                                    "m-class-hard",
                                    tr(l, "红线规矩", "Hard Rule"),
                                    self.rule_class == ConstraintClass::HardRule,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.rule_class = ConstraintClass::HardRule;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                segmented_tab(
                                    "m-class-pref",
                                    tr(l, "日常偏好", "Preference"),
                                    self.rule_class == ConstraintClass::Preference,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.rule_class = ConstraintClass::Preference;
                                        cx.notify();
                                    },
                                )),
                            ),
                    )
                    .child(form_field(
                        tr(l, "分类标识", "Rule Key"),
                        Some("e.g. ui.shadows / git.branch / reply.style".into()),
                        text_input(&self.form_title, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "具体要求", "Rule Content"),
                        None,
                        text_input(&self.form_body, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "原因备注（可选）", "Rationale (optional)"),
                        None,
                        text_input(&self.form_extra, ControlSize::Md).into_any_element(),
                    ))
                    .into_any_element(),
            ),
            ActiveModal::AskRoundtable => (
                tr(l, "发起跨客户端圆桌问询", "Ask Another Client Session"),
                tr(
                    l,
                    "按客户端名与会话 ID 定向投递，对方下次交互会自动看到或按原生会话只读唤起。",
                    "Routes a read-only question to a target client session via Roundtable inbox.",
                ),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
                    .child(form_field(
                        tr(l, "目标客户端", "Target Client"),
                        Some("e.g. claude-code / codex / cursor".into()),
                        text_input(&self.form_title, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "你想问什么？", "Question"),
                        None,
                        text_input(&self.form_body, ControlSize::Md).into_any_element(),
                    ))
                    .child(form_field(
                        tr(l, "目标 Session ID（可选）", "Target Session ID (optional)"),
                        Some("留空则投递到该客户端默认收件箱".into()),
                        text_input(&self.form_extra, ControlSize::Md).into_any_element(),
                    ))
                    .into_any_element(),
            ),
        };

        let footer = div()
            .flex()
            .gap(px(8.0))
            .child(
                secondary_button("modal-cancel", l.t(CopyKey::CancelBtn), ControlSize::Md)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.active_modal = ActiveModal::None;
                        cx.notify();
                    })),
            )
            .child(
                primary_button("modal-submit", l.t(CopyKey::SaveBtn), ControlSize::Md).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.submit_modal(cx);
                    }),
                ),
            )
            .into_any_element();

        Some(modal_overlay(title, subtitle, body, footer))
    }
}

impl Render for FuliAppView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = self.locale();
        let pending_total = self.pending_total();

        let content = match self.tab {
            NavTab::Today => self.render_today(cx),
            NavTab::Agents => self.render_agents(cx),
            NavTab::Memory => self.render_memory(cx),
            NavTab::Graph => self.render_graph(cx),
            NavTab::Roundtable => self.render_concierge_or_inbox(cx),
            NavTab::Settings => self.render_settings(cx),
        };

        let mut top_left_row = div()
            .flex()
            .items_center()
            .gap(px(16.0))
            .child(fuli_brand_lockup("v1.0.0-next", self.status.connected));

        if self.tab == NavTab::Settings {
            let set_idx = match self.settings_sub {
                SettingsSubTab::Clients | SettingsSubTab::General => 0,
                SettingsSubTab::Audit => 1,
                SettingsSubTab::System => 2,
            };
            top_left_row = top_left_row.child(spring_segmented_control(
                "settings-top-spring",
                set_idx,
                104.0,
                vec![
                    spring_segment_slot(
                        "top-sub-clients",
                        tr(l, "客户端", "Clients"),
                        104.0,
                        self.settings_sub == SettingsSubTab::Clients,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.settings_sub = SettingsSubTab::Clients;
                        cx.notify();
                    }))
                    .into_any_element(),
                    spring_segment_slot(
                        "top-sub-audit",
                        l.t(CopyKey::NavInspector),
                        104.0,
                        self.settings_sub == SettingsSubTab::Audit,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.settings_sub = SettingsSubTab::Audit;
                        cx.notify();
                    }))
                    .into_any_element(),
                    spring_segment_slot(
                        "top-sub-sys",
                        tr(l, "系统", "System"),
                        104.0,
                        self.settings_sub == SettingsSubTab::System,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.settings_sub = SettingsSubTab::System;
                        cx.notify();
                    }))
                    .into_any_element(),
                ],
            ));
        }

        let pill_text = if pending_total > 0 {
            if l == Locale::ZhCn {
                format!("有 {pending_total} 件事需要你")
            } else {
                format!("{pending_total} items need you")
            }
        } else {
            tr(l, "一切清爽", "All clear").to_string()
        };

        let running_tasks = self.running_concierge_count();
        let mut top_right_row = div().flex().items_center().gap(px(8.0));
        if running_tasks > 0 {
            top_right_row = top_right_row.child(
                div()
                    .id("top-running-pill")
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .h(px(30.0))
                    .px(px(10.0))
                    .rounded(layout::radius_pill())
                    .bg(colors::surface())
                    .border_1()
                    .border_color(colors::gold())
                    .child(orb_mini_indicator("top-bar-orb", true))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(colors::ink())
                            .child(format!("{running_tasks} 运行中")),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.concierge_sub = ConciergeSubTab::Commander;
                        this.switch_tab(NavTab::Roundtable, cx);
                    })),
            );
        }

        let top_right = top_right_row
            .child(
                status_pill_button("top-status-pill", pill_text, pending_total > 0).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Today, cx);
                    }),
                ),
            )
            .child(
                top_icon_button("top-guide", "info", self.tour_step.is_some()).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.tour_step = if this.tour_step.is_some() {
                            None
                        } else {
                            Some(0)
                        };
                        cx.notify();
                    }),
                ),
            )
            .child(
                top_icon_button(
                    "top-audit",
                    "zap",
                    self.tab == NavTab::Settings && self.settings_sub == SettingsSubTab::Audit,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.settings_sub = SettingsSubTab::Audit;
                    this.switch_tab(NavTab::Settings, cx);
                })),
            )
            .child(
                top_icon_button("top-refresh", "activity", false).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.refresh(cx);
                        let msg = tr(this.locale(), "已刷新最新本地状态", "Refreshed live state");
                        this.push_toast(msg, BadgeTone::Success, cx);
                    },
                )),
            )
            .child(
                top_icon_button("top-settings", "settings", self.tab == NavTab::Settings).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Settings, cx);
                    }),
                ),
            )
            .into_any_element();

        let dock_idx = match self.tab {
            NavTab::Today => 0,
            NavTab::Agents => 1,
            NavTab::Memory => 2,
            NavTab::Graph => 3,
            NavTab::Roundtable => 4,
            NavTab::Settings => 0,
        };
        let dock = spring_floating_dock(
            "app-dock-spring",
            dock_idx,
            vec![
                spring_dock_slot("dock-today", "sun", self.tab == NavTab::Today)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Today, cx);
                    }))
                    .into_any_element(),
                spring_dock_slot("dock-agents", "users", self.tab == NavTab::Agents)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Agents, cx);
                    }))
                    .into_any_element(),
                spring_dock_slot("dock-memory", "layers", self.tab == NavTab::Memory)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Memory, cx);
                    }))
                    .into_any_element(),
                spring_dock_slot("dock-graph", "network", self.tab == NavTab::Graph)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Graph, cx);
                    }))
                    .into_any_element(),
                spring_dock_slot("dock-roundtable", "orbit", self.tab == NavTab::Roundtable)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.switch_tab(NavTab::Roundtable, cx);
                    }))
                    .into_any_element(),
            ],
        );

        let mut root = fuli_shell(
            top_left_row.into_any_element(),
            top_right,
            apple_view_transition(
                format!("nav-view-{:?}", self.tab),
                content.into_any_element(),
            ),
            dock,
        );

        if let Some((ref msg, tone)) = self.toast {
            let auto_dur = if tone == BadgeTone::Danger {
                None
            } else {
                Some(Duration::from_millis(3800))
            };
            root = root.child(floating_toast_overlay(
                format!("app-toast-{}", self.toast_seq),
                ToastPlacement::TopRight,
                tone,
                msg.clone(),
                None,
                auto_dur,
                None,
                Some(
                    top_icon_button("app-toast-close", "x", false)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.toast = None;
                            cx.notify();
                        }))
                        .into_any_element(),
                ),
            ));
        }

        if let Some(step) = self.tour_step {
            let (anchor, badge, title, desc) = match step {
                0 => (
                    TourAnchor::TopLeft,
                    tr(l, "引导 1/3 · 工作台", "Tour 1/3 · Workbench"),
                    tr(
                        l,
                        "一眼看清攒下的习惯和复利曲线",
                        "Your compounding at a glance",
                    ),
                    tr(
                        l,
                        "左侧固定展示一共攒下的习惯和经验，右侧列出真正需要你拍板的红线冲突和各项目近况。",
                        "The left card stays anchored on your compounding trend; the right stream surfaces only real calls.",
                    ),
                ),
                1 => (
                    TourAnchor::BottomLeftAboveDock,
                    tr(l, "引导 2/3 · 弹簧悬浮导航", "Tour 2/3 · Floating Dock"),
                    tr(
                        l,
                        "左下角 5 图标随时切换项目与关系图谱",
                        "5 icons glide smoothly on springs",
                    ),
                    tr(
                        l,
                        "点第 4 个网络图标可以进入「项目关系图谱」，一眼看清谁能共享谁的知识、直接一键确认或断开连线。",
                        "Click the 4th icon to open the Project Relationship Map and authorize cross-KB links in 1 click.",
                    ),
                ),
                _ => (
                    TourAnchor::TopRight,
                    tr(
                        l,
                        "引导 3/3 · 零黑盒与设置",
                        "Tour 3/3 · Transparent AI Context",
                    ),
                    tr(
                        l,
                        "点闪电看「AI 收到过什么」，点齿轮管接入",
                        "See what AI received & manage clients",
                    ),
                    tr(
                        l,
                        "所有客户端接入前都会自动备份原配置；关掉本窗口后显存会立刻归零，后台托盘继续 10 MiB 静默运行。",
                        "Every client edit backs up your config first; closing this window frees 100% of GPU RAM immediately.",
                    ),
                ),
            };
            let mut ctrls = div().flex().items_center().gap(px(6.0));
            if step > 0 {
                ctrls = ctrls.child(
                    ghost_button("app-tour-prev", tr(l, "上一步", "Back"), ControlSize::Sm)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.tour_step = this.tour_step.map(|s| s.saturating_sub(1));
                            cx.notify();
                        })),
                );
            } else {
                ctrls = ctrls.child(
                    ghost_button("app-tour-skip", tr(l, "跳过", "Skip"), ControlSize::Sm).on_click(
                        cx.listener(|this, _, _, cx| {
                            this.tour_step = None;
                            cx.notify();
                        }),
                    ),
                );
            }
            if step < 2 {
                ctrls = ctrls.child(
                    primary_button("app-tour-next", tr(l, "下一步", "Next"), ControlSize::Sm)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.tour_step = Some(step + 1);
                            cx.notify();
                        })),
                );
            } else {
                ctrls = ctrls.child(
                    primary_button("app-tour-done", tr(l, "知道了", "Got it"), ControlSize::Sm)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.tour_step = None;
                            cx.notify();
                        })),
                );
            }

            root = root.child(guided_tour_popover(
                format!("app-tour-{step}"),
                anchor,
                step,
                3,
                badge,
                title,
                desc,
                ctrls.into_any_element(),
            ));
        }

        if let Some(ref detail) = self.detail_item {
            root = root.child(self.render_detail_drawer(detail, cx));
        }

        if let Some(modal) = self.render_active_modal(cx) {
            root = root.child(modal);
        }

        root
    }
}

struct UiArgs {
    endpoint: String,
    close_grace_secs: u64,
    auto_close_ms: Option<u64>,
}

fn parse_args() -> UiArgs {
    let mut ipc_name = None;
    let mut close_grace_secs = 30u64;
    let mut auto_close_ms = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--ipc-name" => ipc_name = args.next(),
            "--close-grace-secs" => {
                if let Some(raw) = args.next()
                    && let Ok(parsed) = raw.parse::<u64>()
                {
                    close_grace_secs = parsed;
                }
            }
            "--auto-close-ms" => {
                if let Some(raw) = args.next()
                    && let Ok(parsed) = raw.parse::<u64>()
                {
                    auto_close_ms = Some(parsed);
                }
            }
            _ => {}
        }
    }

    UiArgs {
        endpoint: resolve_ipc_name(ipc_name.as_deref()),
        close_grace_secs,
        auto_close_ms,
    }
}

fn main() {
    let args = parse_args();
    let endpoint = args.endpoint;
    let close_grace_secs = args.close_grace_secs;
    let auto_close_ms = args.auto_close_ms;

    gpui_kit::application()
        .with_assets(FuliAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            apply_fuli_theme(cx);

            let close_endpoint = endpoint.clone();
            cx.on_window_closed(move |cx, _window_id| {
                if cx.windows().is_empty() {
                    let _ = send_request(
                        &close_endpoint,
                        &IpcRequest::NotifyUiClosing {
                            grace_secs: close_grace_secs,
                        },
                    );
                    if close_grace_secs == 0 {
                        cx.quit();
                    } else {
                        cx.spawn(async move |cx| {
                            cx.background_executor()
                                .timer(Duration::from_secs(close_grace_secs))
                                .await;
                            cx.update(|cx| {
                                if cx.windows().is_empty() {
                                    cx.quit();
                                }
                            });
                        })
                        .detach();
                    }
                }
            })
            .detach();

            let bounds = Bounds::centered(None, size(px(1180.0), px(780.0)), cx);
            let options = fuli_window_options(bounds, size(px(900.0), px(620.0)));

            let view_endpoint = endpoint.clone();
            let (window_handle, _view) = gpui_kit::open_window(options, cx, move |window, cx| {
                cx.new(|cx| FuliAppView::new(view_endpoint, close_grace_secs, window, cx))
            })
            .expect("failed to open FULI GPUI window");

            if let Some(delay_ms) = auto_close_ms {
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(delay_ms))
                        .await;
                    cx.update(|cx| {
                        let _ = window_handle.update(cx, |_, window, _| {
                            window.remove_window();
                        });
                    });
                })
                .detach();
            }
        });
}
