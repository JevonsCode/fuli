mod memory;
mod state;

use std::time::Duration;

use fuli_domain::{
    AutonomyLevel, ConstraintClass, DeliveryMode, KbItemStatus, LinkAuthority, RuleScope,
    RuleStatus, WakeStatus, WorkflowStatus, WorkstreamStatus,
};
use fuli_ipc::{IpcRequest, resolve_ipc_name, send_request};
use fuli_ui_kit::{
    BadgeTone, ControlSize, CopyKey, InputEvent, InputState, Locale, apply_fuli_theme, colors,
    conflict_split_card, copy_button, danger_button, detail_drawer, divider, dock_item,
    empty_state, floating_dock, form_field, fuli_shell, growth_loading, inset_list_row,
    inset_panel, kbd_chip, kv_row, modal_overlay, notice_banner, primary_button, progress_bar,
    scroll_area, search_bar, secondary_button, section_card, section_header, segmented_tab,
    sparkline_bars, stat_tile, status_badge, tag_chip, text_input, toast_pill, toggle_switch,
    typography,
};
use gpui_kit::*;
use serde_json::json;

use state::{
    DaemonStatusView, ItemDetailData, SearchResultData, dispatch_ui_action, session_resume_command,
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
    Roundtable,
    Inspector,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemorySubTab {
    Knowledge,
    Rules,
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
    memory_sub: MemorySubTab,
    kb_filter: KbFilter,
    selected_agent_id: Option<String>,
    selected_kb_id: Option<String>,
    toast: Option<(String, BadgeTone)>,
    copied_session_key: Option<String>,
    search_input: Entity<InputState>,
    search_result: Option<SearchResultData>,
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

        let search_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("输入中文或英文关键词搜索知识（回车即查）...")
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

        Self {
            endpoint,
            close_grace_secs,
            tab: NavTab::Today,
            memory_sub: MemorySubTab::Knowledge,
            kb_filter: KbFilter::All,
            selected_agent_id,
            selected_kb_id,
            toast: None,
            copied_session_key: None,
            search_input,
            search_result: None,
            detail_item: None,
            active_modal: ActiveModal::None,
            form_title,
            form_body,
            form_extra,
            rule_scope: RuleScope::Agent,
            rule_class: ConstraintClass::HardRule,
            status,
            _subscriptions: vec![search_sub],
        }
    }

    fn locale(&self) -> Locale {
        Locale::from_code(&self.status.data.ui_locale)
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
                self.toast = Some((ok_msg.to_string(), BadgeTone::Success));
                self.refresh(cx);
            }
            Err(err) => {
                self.toast = Some((format!("操作没成功：{err}"), BadgeTone::Danger));
                cx.notify();
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
                    self.toast = Some(("请先填写 FULI Agent 名称".into(), BadgeTone::Warning));
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
                self.run_action("create_agent", payload, "已创建新的 FULI Agent 档案", cx);
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
                            "项目级规矩需要先选中一个 FULI Agent".into(),
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

    fn page_heading(&self) -> &'static str {
        let l = self.locale();
        match self.tab {
            NavTab::Today => l.t(CopyKey::NavToday),
            NavTab::Agents => l.t(CopyKey::NavAgents),
            NavTab::Memory => l.t(CopyKey::NavMemory),
            NavTab::Roundtable => l.t(CopyKey::NavRoundtable),
            NavTab::Inspector => l.t(CopyKey::NavInspector),
            NavTab::Settings => l.t(CopyKey::NavSettings),
        }
    }

    // =========================================================================
    // View 1: Today
    // =========================================================================

    fn render_today(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let portfolio = &data.portfolio;

        let pending_total = data.rule_conflicts.len()
            + data.pending.proposed_items.len()
            + data.pending.pending_rules.len()
            + data.pending.proposed_workflows.len()
            + data.pending.stale_items.len();

        let left_stage = section_card()
            .flex_1()
            .justify_between()
            .child(section_header(
                l.t(CopyKey::WeeklyStatement),
                Some(
                    status_badge(
                        if self.status.connected {
                            format!(
                                "{} {:.1} MiB",
                                tr(l, "后台", "Daemon"),
                                self.status.daemon_mem.working_set_mib()
                            )
                        } else {
                            tr(l, "后台未启动", "Daemon Offline").into()
                        },
                        if self.status.connected {
                            BadgeTone::Gold
                        } else {
                            BadgeTone::Warning
                        },
                    )
                    .into_any_element(),
                ),
            ))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.0))
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
                                    .child(portfolio.compounding_events_count.to_string()),
                            )
                            .child(
                                div()
                                    .text_size(typography::body_size())
                                    .text_color(colors::muted())
                                    .child(l.t(CopyKey::CompoundingCountSub)),
                            ),
                    )
                    .child(sparkline_bars(&portfolio.weekly_compounding_series))
                    .child(
                        div()
                            .text_size(typography::meta_size())
                            .text_color(colors::muted())
                            .child(tr(
                                l,
                                "近 7 周复利趋势（右侧高亮为本周真实生效次数）",
                                "7-week compounding trend (rightmost bar = this week)",
                            )),
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
                                    .id("tile-jump-agents")
                                    .flex_1()
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Agents, cx);
                                    }))
                                    .child(stat_tile(
                                        portfolio.total_agents.to_string(),
                                        tr(l, "活跃 FULI Agent", "Active FULI Agents"),
                                        format!(
                                            "{} {}",
                                            portfolio.active_workstreams,
                                            tr(l, "条进行中工作线 →", "open workstreams →")
                                        ),
                                    )),
                            )
                            .child(
                                div()
                                    .id("tile-jump-memory")
                                    .flex_1()
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Memory, cx);
                                    }))
                                    .child(stat_tile(
                                        portfolio.new_confirmed_knowledge.to_string(),
                                        tr(l, "本周新增确认知识", "Confirmed Knowledge"),
                                        format!(
                                            "{} {} →",
                                            data.knowledge_bases.len(),
                                            tr(l, "个知识库", "knowledge bases")
                                        ),
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(10.0))
                            .child(stat_tile(
                                pending_total.to_string(),
                                l.t(CopyKey::WaitingForYou),
                                if data.rule_conflicts.is_empty() {
                                    tr(l, "目前没有红线冲突", "Zero hard-rule conflicts").into()
                                } else {
                                    format!(
                                        "{} {}",
                                        data.rule_conflicts.len(),
                                        tr(l, "处规则冲突", "rule conflicts")
                                    )
                                },
                            ))
                            .child(
                                div()
                                    .id("tile-jump-inspector")
                                    .flex_1()
                                    .cursor_pointer()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Inspector, cx);
                                    }))
                                    .child(stat_tile(
                                        format!("~{}", data.tokens_saved),
                                        tr(l, "去重省下 Token", "Tokens Saved"),
                                        tr(l, "查看交付透视镜 →", "Open Delivery Inspector →"),
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
                secondary_button(
                    "btn-dreaming-run",
                    l.t(CopyKey::DreamingRunBtn),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.run_action("run_dreaming", json!({}), "已完成本地零模型整理扫描", cx);
                }))
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
            for cp in &portfolio.recent_checkpoints {
                portfolio_card = portfolio_card.child(
                    inset_panel()
                        .child(
                            div()
                                .text_size(typography::control_size())
                                .font_weight(typography::WEIGHT_MEDIUM)
                                .child(format!("{} · {}", cp.agent_name, cp.workstream_title)),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(format!("{} ({})", cp.current_state, cp.source_client)),
                        ),
                );
            }
        }

        let right_stream = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .pb(px(12.0))
            .child(decisions_card)
            .child(dreaming_card)
            .child(portfolio_card);

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(left_stage)
            .child(
                div()
                    .flex_1()
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

        let left_box = inset_panel()
            .flex_1()
            .bg(colors::surface())
            .child(
                div()
                    .text_size(typography::control_size())
                    .text_color(colors::ink())
                    .child(left_rule.content),
            )
            .child(
                primary_button(
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

        let right_box = inset_panel()
            .flex_1()
            .bg(colors::surface())
            .child(
                div()
                    .text_size(typography::control_size())
                    .text_color(colors::ink())
                    .child(right_rule.content),
            )
            .child(
                primary_button(
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
    // View 2: FULI Agent Unified Multi-Client Workbench
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
                tr(l, "还没有绑定项目", "No FULI Agents yet"),
                tr(
                    l,
                    "点上方「+ 新建 FULI Agent」，或在项目目录触发一次 Hook 自动建档。",
                    "Click '+ New FULI Agent' above, or run a Hook inside any Git workspace.",
                ),
            ));
        } else {
            for (idx, card) in data.agents.iter().enumerate() {
                let aid = card.agent.id.clone();
                let is_sel = selected_id.as_deref() == Some(aid.as_str());
                list_items = list_items.child(
                    inset_list_row(
                        format!("agent-row-{idx}"),
                        card.agent.name.clone(),
                        format!(
                            "{} {} · {} {} · {} {}",
                            card.bindings.len(),
                            tr(l, "绑定", "bindings"),
                            card.mounts.len(),
                            tr(l, "挂载", "mounted"),
                            card.authorized_kbs.len(),
                            tr(l, "授权库", "KBs")
                        ),
                        is_sel,
                        Some(
                            status_badge(card.agent.reply_lang.clone(), BadgeTone::Neutral)
                                .into_any_element(),
                        ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_agent_id = Some(aid.clone());
                        cx.notify();
                    })),
                );
            }
        }

        let list_card = section_card()
            .w(px(330.0))
            .min_h(px(0.0))
            .child(section_header(
                tr(l, "我的 FULI Agent", "My FULI Agents"),
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
                            "重复跑通的固定流程（如双端发版检查、回归验证）可以沉淀成这个 FULI Agent 的标准工作流。",
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
                tr(l, "在左侧选一个 FULI Agent", "Select a FULI Agent on the left"),
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
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(scroll_area("agents-detail-scroll", detail_col)),
            )
    }

    // =========================================================================
    // View 3: Memory (Knowledge + Rules)
    // =========================================================================

    fn render_memory(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let top_bar = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        segmented_tab(
                            "mem-tab-kb",
                            l.t(CopyKey::TabKnowledge),
                            self.memory_sub == MemorySubTab::Knowledge,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.memory_sub = MemorySubTab::Knowledge;
                            cx.notify();
                        })),
                    )
                    .child(
                        segmented_tab(
                            "mem-tab-rules",
                            l.t(CopyKey::TabRules),
                            self.memory_sub == MemorySubTab::Rules,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.memory_sub = MemorySubTab::Rules;
                            cx.notify();
                        })),
                    ),
            )
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
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(top_bar)
            .child(body)
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
                        "Isolated per FULI Agent — never leaks across repositories.",
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
    // View 5: Delivery Inspector
    // =========================================================================

    fn render_inspector(&self) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let mut rows = div().flex().flex_col().gap(px(8.0)).pb(px(12.0));

        if data.deliveries.is_empty() {
            rows = rows.child(empty_state(
                tr(l, "还没有交付记录", "No deliveries recorded yet"),
                tr(
                    l,
                    "一旦你在任意 AI 客户端发消息或检索知识，这里就会逐条展示哪些完整注入、哪些去重跳过。",
                    "Every rule injection, dedup skip, and on-demand knowledge search appears here transparently.",
                ),
            ));
        } else {
            for rec in &data.deliveries {
                let (mode_label, tone) = match rec.delivery_mode {
                    DeliveryMode::Full => (tr(l, "完整下发", "Delivered"), BadgeTone::Gold),
                    DeliveryMode::SkippedDedup => {
                        (tr(l, "去重跳过", "Dedup Skipped"), BadgeTone::Success)
                    }
                    DeliveryMode::DeltaRemoved => {
                        (tr(l, "通知失效", "Removed"), BadgeTone::Warning)
                    }
                    DeliveryMode::TitleOnly => {
                        (tr(l, "仅传标题", "Title Only"), BadgeTone::Neutral)
                    }
                    DeliveryMode::TruncatedBudget => {
                        (tr(l, "预算截断", "Budget Trim"), BadgeTone::Danger)
                    }
                };
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
                                    .child(
                                        div()
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .child(format!(
                                                "{} · epoch {} · turn {} · {}",
                                                rec.client_id,
                                                rec.context_epoch,
                                                rec.turn_seq,
                                                rec.reason
                                            )),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::muted())
                                            .child(format!(
                                                "~{} tok · v{} · {}",
                                                rec.tokens_est,
                                                rec.target_revision,
                                                rec.trigger_kind
                                            )),
                                    ),
                            )
                            .child(status_badge(mode_label, tone)),
                    ),
                );
            }
        }

        div().flex_1().min_h(px(0.0)).flex().child(
            section_card()
                .flex_1()
                .min_h(px(0.0))
                .child(section_header(
                    tr(
                        l,
                        "交付透视镜（每次给 AI 传了什么、省了什么）",
                        "Delivery Inspector (Zero Black-Box Context)",
                    ),
                    Some(
                        status_badge(
                            format!("~{} tok {}", data.tokens_saved, tr(l, "已省", "saved")),
                            BadgeTone::Success,
                        )
                        .into_any_element(),
                    ),
                ))
                .child(scroll_area("inspector-scroll", rows)),
        )
    }

    // =========================================================================
    // View 6: Settings (Live AI Client Cards + Memory Telemetry + Export + Autonomy)
    // =========================================================================

    fn render_settings(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let auto = data.autonomy_level;
        let mem_ratio = (self.status.daemon_mem.working_set_mib() / 25.0) as f32;

        // AI Client Connection Cards (Claude Code / Codex / Cursor / OpenCode)
        let mut clients_card = section_card().child(section_header(
            tr(l, "本机 AI 客户端一键接入", "Local AI Client Integrations"),
            Some(
                status_badge(
                    tr(l, "写入前自动备份原配置", "Auto-backup before write"),
                    BadgeTone::Neutral,
                )
                .into_any_element(),
            ),
        ));

        for (idx, cl) in data.clients.iter().enumerate() {
            let cid = cl.client.clone();
            let cid_rm = cl.client.clone();
            let (st_text, st_tone) = if cl.fuli_configured {
                (tr(l, "已接入", "Connected"), BadgeTone::Success)
            } else if cl.config_dir_exists {
                (tr(l, "未接入", "Detected"), BadgeTone::Warning)
            } else {
                (tr(l, "未检测", "Not Found"), BadgeTone::Neutral)
            };
            let action_btn = if cl.fuli_configured {
                danger_button(
                    format!("cl-rm-{idx}"),
                    tr(l, "安全移除", "Remove"),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_action(
                        "remove_client",
                        json!({ "client": cid_rm }),
                        "已安全移除 FULI 配置（原配置已备份且其他设置完好）",
                        cx,
                    );
                }))
                .into_any_element()
            } else {
                primary_button(
                    format!("cl-add-{idx}"),
                    tr(l, "一键接入", "Connect"),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.run_action(
                        "setup_client",
                        json!({ "client": cid }),
                        "已写入 FULI Hook/MCP 配置（原文件已自动备份）",
                        cx,
                    );
                }))
                .into_any_element()
            };

            clients_card = clients_card.child(
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
                                        .child(
                                            div()
                                                .text_size(typography::body_size())
                                                .font_weight(typography::WEIGHT_MEDIUM)
                                                .child(cl.display_name.clone()),
                                        )
                                        .child(status_badge(st_text, st_tone))
                                        .child(tag_chip(if cl.supports_hooks {
                                            "Hook + MCP"
                                        } else {
                                            "MCP"
                                        })),
                                )
                                .child(
                                    div()
                                        .text_size(typography::meta_size())
                                        .text_color(colors::muted())
                                        .child(cl.config_path.clone()),
                                ),
                        )
                        .child(action_btn),
                ),
            );
        }

        let telemetry_card = section_card()
            .child(section_header(
                tr(l, "本机进程与资源占用", "Process & Memory Telemetry"),
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
                                "后台常驻内存水位（红线 25.0 MiB）",
                                "Daemon RAM vs 25 MiB target",
                            ))
                            .child(format!(
                                "{:.2} / 25.0 MiB",
                                self.status.daemon_mem.working_set_mib()
                            )),
                    )
                    .child(progress_bar(
                        mem_ratio,
                        if mem_ratio < 0.8 {
                            BadgeTone::Success
                        } else {
                            BadgeTone::Warning
                        },
                    )),
            )
            .child(kv_row(
                "fuli-context",
                if self.status.connected {
                    format!(
                        "{:.2} MiB WS / {:.2} MiB Priv (PID {})",
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
                    "按需向量缓存（60s 自动卸载）",
                    "On-Demand Vector Cache (60s idle TTL)",
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
                tr(l, "本地 IPC & 运行时长", "Local IPC & Uptime"),
                format!(
                    "{:.2} ms · {}s",
                    self.status.ipc_rtt_ms, self.status.uptime_secs
                ),
            ))
            .child(kv_row(
                tr(l, "唯一数据库", "SQLite WAL DB"),
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
                            "btn-refresh-set",
                            l.t(CopyKey::RefreshBtn),
                            ControlSize::Md,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.refresh(cx);
                        })),
                    )
                    .child(
                        secondary_button(
                            "btn-export-json",
                            tr(l, "导出便携 JSON 备份", "Export Portable JSON"),
                            ControlSize::Md,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            match dispatch_ui_action(&this.endpoint, "export_to_file", json!({})) {
                                Ok(val) => {
                                    let path = val["path"].as_str().unwrap_or("").to_string();
                                    cx.write_to_clipboard(ClipboardItem::new_string(path.clone()));
                                    this.toast = Some((
                                        format!("已导出纯净备份并复制路径：{path}"),
                                        BadgeTone::Success,
                                    ));
                                }
                                Err(err) => {
                                    this.toast =
                                        Some((format!("导出失败：{err}"), BadgeTone::Danger));
                                }
                            }
                            cx.notify();
                        })),
                    )
                    .child(
                        secondary_button(
                            "btn-close-free",
                            l.t(CopyKey::CloseAndFreeBtn),
                            ControlSize::Md,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            let _ = send_request(
                                &this.endpoint,
                                &IpcRequest::NotifyUiClosing { grace_secs: 0 },
                            );
                            cx.quit();
                        })),
                    ),
            );

        let prefs_card = section_card()
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
                            .text_size(typography::body_size())
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .child("界面语言 / Language"),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(6.0))
                            .child(segmented_tab("lang-zh", "中文", l == Locale::ZhCn).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.run_action(
                                        "set_locale",
                                        json!({ "locale": "zh-CN" }),
                                        "已切换为中文",
                                        cx,
                                    );
                                }),
                            ))
                            .child(
                                segmented_tab("lang-en", "English", l == Locale::EnUs).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.run_action(
                                            "set_locale",
                                            json!({ "locale": "en-US" }),
                                            "Switched to English",
                                            cx,
                                        );
                                    }),
                                ),
                            ),
                    ),
            )
            .child(growth_loading(tr(
                l,
                "复利内核就绪 · 零后台模型占用",
                "Compounding kernel ready · zero background LLM usage",
            )));

        let left_col = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .pb(px(12.0))
            .child(clients_card)
            .child(telemetry_card);
        let right_col = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .pb(px(12.0))
            .child(prefs_card);

        div()
            .flex_1()
            .min_h(px(0.0))
            .flex()
            .gap(px(18.0))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(scroll_area("settings-left-scroll", left_col)),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .flex()
                    .flex_col()
                    .child(scroll_area("settings-right-scroll", right_col)),
            )
    }

    // =========================================================================
    // Overlays: Right Version-History Drawer & Centered Create Modals
    // =========================================================================

    fn render_detail_drawer(&self, detail: &ItemDetailData, cx: &mut Context<Self>) -> Div {
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

    fn render_active_modal(&self, cx: &mut Context<Self>) -> Option<Div> {
        let l = self.locale();
        if self.active_modal == ActiveModal::None {
            return None;
        }

        let (title, subtitle, body) = match self.active_modal {
            ActiveModal::None => unreachable!(),
            ActiveModal::NewAgent => (
                tr(l, "新建 FULI Agent 档案", "New FULI Agent"),
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

        let content = match self.tab {
            NavTab::Today => self.render_today(cx),
            NavTab::Agents => self.render_agents(cx),
            NavTab::Memory => self.render_memory(cx),
            NavTab::Roundtable => self.render_roundtable(cx),
            NavTab::Inspector => self.render_inspector(),
            NavTab::Settings => self.render_settings(cx),
        };

        let top_right = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                segmented_tab(
                    "top-inspector",
                    l.t(CopyKey::NavInspector),
                    self.tab == NavTab::Inspector,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Inspector, cx);
                })),
            )
            .child(
                segmented_tab(
                    "top-settings",
                    l.t(CopyKey::NavSettings),
                    self.tab == NavTab::Settings,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Settings, cx);
                })),
            )
            .child(
                secondary_button("top-refresh", l.t(CopyKey::RefreshBtn), ControlSize::Sm)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.refresh(cx);
                    })),
            )
            .into_any_element();

        let dock = floating_dock()
            .child(
                dock_item(
                    "dock-today",
                    l.t(CopyKey::NavToday),
                    self.tab == NavTab::Today,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Today, cx);
                })),
            )
            .child(
                dock_item(
                    "dock-agents",
                    l.t(CopyKey::NavAgents),
                    self.tab == NavTab::Agents,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Agents, cx);
                })),
            )
            .child(
                dock_item(
                    "dock-memory",
                    l.t(CopyKey::NavMemory),
                    self.tab == NavTab::Memory,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Memory, cx);
                })),
            )
            .child(
                dock_item(
                    "dock-roundtable",
                    l.t(CopyKey::NavRoundtable),
                    self.tab == NavTab::Roundtable,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.switch_tab(NavTab::Roundtable, cx);
                })),
            )
            .into_any_element();

        let mut root = fuli_shell(
            l.t(CopyKey::Brand),
            self.status.connected,
            self.page_heading(),
            top_right,
            content.into_any_element(),
            dock,
        );

        if let Some((ref msg, tone)) = self.toast {
            root = root.child(
                div()
                    .absolute()
                    .top(px(66.0))
                    .right(px(24.0))
                    .child(toast_pill(msg.clone(), tone)),
            );
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

    gpui_kit::application().run(move |cx| {
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
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("FULI 复利".into()),
                appears_transparent: false,
                traffic_light_position: None,
            }),
            ..WindowOptions::default()
        };

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
