mod memory;
mod state;

use std::time::Duration;

use fuli_domain::{
    AutonomyLevel, ConstraintClass, DeliveryMode, KbItemStatus, LinkAuthority, RuleScope,
    RuleStatus, WakeStatus, WorkflowStatus, WorkstreamStatus,
};
use fuli_ipc::{IpcRequest, resolve_ipc_name, send_request};
use fuli_ui_kit::{
    BadgeTone, ControlSize, CopyKey, Locale, colors, conflict_split_card, danger_button, dock_item,
    empty_state, floating_dock, inset_list_row, kv_row, layout, notice_banner, primary_button,
    secondary_button, section_card, section_header, segmented_tab, sparkline_bars, stat_tile,
    status_badge, typography,
};
use gpui_kit::*;
use serde_json::json;

use state::{DaemonStatusView, dispatch_ui_action};

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

struct FuliAppView {
    endpoint: String,
    close_grace_secs: u64,
    tab: NavTab,
    memory_sub: MemorySubTab,
    selected_agent_id: Option<String>,
    selected_kb_id: Option<String>,
    toast: Option<String>,
    status: DaemonStatusView,
}

impl FuliAppView {
    fn new(endpoint: String, close_grace_secs: u64) -> Self {
        let status = DaemonStatusView::fetch(&endpoint);
        let selected_agent_id = status.data.agents.first().map(|a| a.agent.id.clone());
        let selected_kb_id = status.data.knowledge_bases.first().map(|k| k.id.clone());
        Self {
            endpoint,
            close_grace_secs,
            tab: NavTab::Today,
            memory_sub: MemorySubTab::Knowledge,
            selected_agent_id,
            selected_kb_id,
            toast: None,
            status,
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
                self.toast = Some(ok_msg.to_string());
                self.refresh(cx);
            }
            Err(err) => {
                self.toast = Some(format!("操作没成功：{err}"));
                cx.notify();
            }
        }
    }

    fn switch_tab(&mut self, tab: NavTab, cx: &mut Context<Self>) {
        self.tab = tab;
        self.toast = None;
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
    // View 1: Today (工作台 — 左半复利账单 + 右半等你拍板 / 整理建议 / 跨项目周报)
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

        // Left fixed column: Compounding statement stage
        let left_stage = section_card()
            .flex_1()
            .justify_between()
            .child(section_header(
                l.t(CopyKey::WeeklyStatement),
                Some(
                    status_badge(
                        if self.status.connected {
                            format!("后台 {:.1} MiB", self.status.daemon_mem.working_set_mib())
                        } else {
                            "后台未启动".into()
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
                            .child("近 7 周复利趋势（右侧高亮为本周真实生效次数）"),
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
                            .child(stat_tile(
                                portfolio.total_agents.to_string(),
                                "活跃 FULI Agent",
                                format!("{} 条进行中工作线", portfolio.active_workstreams),
                            ))
                            .child(stat_tile(
                                portfolio.new_confirmed_knowledge.to_string(),
                                "本周新增确认知识",
                                format!("共 {} 个知识库", data.knowledge_bases.len()),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(10.0))
                            .child(stat_tile(
                                pending_total.to_string(),
                                "等你拍板",
                                if data.rule_conflicts.is_empty() {
                                    "目前没有红线冲突".into()
                                } else {
                                    format!("含 {} 处规则冲突", data.rule_conflicts.len())
                                },
                            ))
                            .child(stat_tile(
                                format!("~{}", data.tokens_saved),
                                "去重省下 Token",
                                "同一会话绝不重复注入规矩",
                            )),
                    ),
            );

        // Right column: Needs Your Call + Dreaming + Cross-Project Weekly Digest
        let mut decisions_card = section_card().child(section_header(
            l.t(CopyKey::WaitingForYou),
            Some(
                status_badge(
                    format!("{pending_total} 项"),
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
            // 1. Red rule conflicts first (highest priority)
            for (idx, conflict) in data.rule_conflicts.iter().take(2).enumerate() {
                if conflict.candidates.len() >= 2 {
                    let left_rule = conflict.candidates[0].clone();
                    let right_rule = conflict.candidates[1].clone();
                    let left_id = left_rule.id.clone();
                    let right_id = right_rule.id.clone();
                    let all_ids: Vec<String> =
                        conflict.candidates.iter().map(|c| c.id.clone()).collect();
                    let all_ids_r = all_ids.clone();

                    let left_box = div()
                        .flex_1()
                        .bg(colors::surface())
                        .border_1()
                        .border_color(colors::border())
                        .rounded(layout::radius_control())
                        .p(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .text_size(typography::control_size())
                                .text_color(colors::ink())
                                .child(left_rule.content.clone()),
                        )
                        .child(
                            primary_button(
                                format!("conflict-left-{idx}"),
                                l.t(CopyKey::PickThisBtn),
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.run_action(
                                        "resolve_conflict",
                                        json!({ "winner_id": left_id, "loser_ids": all_ids }),
                                        "已为你保留所选规矩，另一条已停用",
                                        cx,
                                    );
                                },
                            )),
                        )
                        .into_any_element();

                    let right_box = div()
                        .flex_1()
                        .bg(colors::surface())
                        .border_1()
                        .border_color(colors::border())
                        .rounded(layout::radius_control())
                        .p(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(
                            div()
                                .text_size(typography::control_size())
                                .text_color(colors::ink())
                                .child(right_rule.content.clone()),
                        )
                        .child(
                            primary_button(
                                format!("conflict-right-{idx}"),
                                l.t(CopyKey::PickThisBtn),
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.run_action(
                                        "resolve_conflict",
                                        json!({ "winner_id": right_id, "loser_ids": all_ids_r }),
                                        "已为你保留所选规矩，另一条已停用",
                                        cx,
                                    );
                                },
                            )),
                        )
                        .into_any_element();

                    decisions_card = decisions_card.child(conflict_split_card(
                        format!("规矩打架了：{}", conflict.pref_key),
                        conflict.reason.clone(),
                        left_box,
                        right_box,
                    ));
                }
            }

            // 2. Pending rules/preferences proposed by AI
            for (idx, rule) in data.pending.pending_rules.iter().take(3).enumerate() {
                let rid_ok = rule.id.clone();
                let rid_hard = rule.id.clone();
                let rid_no = rule.id.clone();
                decisions_card = decisions_card.child(
                    div()
                        .bg(colors::subtle())
                        .rounded(layout::radius_control())
                        .p(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
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

            // 3. Pending KB proposals
            for (idx, item) in data.pending.proposed_items.iter().take(3).enumerate() {
                let iid_ok = item.id.clone();
                let iid_no = item.id.clone();
                decisions_card = decisions_card.child(
                    div()
                        .bg(colors::subtle())
                        .rounded(layout::radius_control())
                        .p(px(12.0))
                        .flex()
                        .flex_col()
                        .gap(px(6.0))
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

        // Dreaming L1 curation card
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
        if data.dreaming.suggestions.is_empty() {
            dreaming_card = dreaming_card.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(format!(
                        "已扫描 {} 条确认知识 · 重复 {} 组 · 过时 {} 条 · 值得沉淀 {} 条",
                        data.dreaming.scanned_items,
                        data.dreaming.duplicate_pairs_found,
                        data.dreaming.stale_items_found,
                        data.dreaming.promotion_candidates_found
                    )),
            );
        } else {
            dreaming_card = dreaming_card.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(format!(
                        "已扫描 {} 条 · 发现重复 {} 组 · 过时 {} 条 · 可升格 {} 条",
                        data.dreaming.scanned_items,
                        data.dreaming.duplicate_pairs_found,
                        data.dreaming.stale_items_found,
                        data.dreaming.promotion_candidates_found
                    )),
            );
            for sug in data.dreaming.suggestions.iter().take(3) {
                dreaming_card = dreaming_card.child(notice_banner(
                    BadgeTone::Gold,
                    sug.headline.clone(),
                    format!("{} · {}", sug.detail, sug.action_hint),
                ));
            }
        }

        // Cross-project weekly digest card (Jefa value)
        let mut portfolio_card = section_card().child(section_header(
            l.t(CopyKey::PortfolioTitle),
            Some(
                status_badge(
                    format!("近 {} 天", portfolio.since_days),
                    BadgeTone::Neutral,
                )
                .into_any_element(),
            ),
        ));
        if portfolio.recent_checkpoints.is_empty() {
            portfolio_card = portfolio_card.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child("当你在 Claude Code / Codex 里记录里程碑后，这里会自动汇总所有项目的进展，方便写日报和周报。"),
            );
        } else {
            for cp in portfolio.recent_checkpoints.iter().take(4) {
                portfolio_card = portfolio_card.child(
                    div()
                        .bg(colors::subtle())
                        .rounded(layout::radius_control())
                        .px(px(12.0))
                        .py(px(8.0))
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
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
                                .child(format!(
                                    "{}（来源：{}）",
                                    cp.current_state, cp.source_client
                                )),
                        ),
                );
            }
        }

        div().flex_1().flex().gap(px(18.0)).child(left_stage).child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(14.0))
                .child(decisions_card)
                .child(dreaming_card)
                .child(portfolio_card),
        )
    }

    // =========================================================================
    // View 2: FULI Agent Unified Multi-Client Workbench (FLA + Sessions + Workflows)
    // =========================================================================

    fn render_agents(&self, cx: &mut Context<Self>) -> Div {
        let data = &self.status.data;
        let selected_id = self
            .selected_agent_id
            .clone()
            .or_else(|| data.agents.first().map(|a| a.agent.id.clone()));

        let mut list_card = section_card().w(px(320.0)).child(section_header(
            "我的 FULI Agent",
            Some(
                status_badge(format!("{} 个", data.agents.len()), BadgeTone::Neutral)
                    .into_any_element(),
            ),
        ));

        if data.agents.is_empty() {
            list_card = list_card.child(empty_state(
                "还没有绑定项目",
                "在任意项目目录触发一次 Hook 或调用 resolve_context，即可自动建立 FULI Agent 档案。",
            ));
        } else {
            for (idx, card) in data.agents.iter().enumerate() {
                let aid = card.agent.id.clone();
                let is_sel = selected_id.as_deref() == Some(aid.as_str());
                let repo_count = card.bindings.len();
                let mount_count = card.mounts.len();
                let kb_count = card.authorized_kbs.len();
                list_card = list_card.child(
                    inset_list_row(
                        format!("agent-row-{idx}"),
                        card.agent.name.clone(),
                        format!("{repo_count} 个绑定 · 挂载 {mount_count} 库 · 可查 {kb_count} 库"),
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

        let mut detail_col = div().flex_1().flex().flex_col().gap(px(14.0));
        if let Some(ref sid) = selected_id
            && let Some(selected) = data.agents.iter().find(|a| &a.agent.id == sid)
        {
            // Live cross-client sessions (T3 / Orca / OpenMausBot unified view)
            let agent_sessions: Vec<_> = data
                .sessions
                .iter()
                .filter(|s| s.agent_id.as_deref() == Some(sid.as_str()))
                .collect();
            let mut sessions_card = section_card().child(section_header(
                format!("{} · 各客户端活跃会话", selected.agent.name),
                Some(
                    status_badge(
                        format!("{} 个会话", agent_sessions.len()),
                        BadgeTone::Success,
                    )
                    .into_any_element(),
                ),
            ));
            if agent_sessions.is_empty() {
                sessions_card = sessions_card.child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child("Claude Code、Codex、Cursor 等客户端接入后，会在这里统一列出各自所在目录与上下文轮次。"),
                );
            } else {
                for s in agent_sessions.iter().take(5) {
                    sessions_card = sessions_card.child(kv_row(
                        format!("{} · {}", s.client_id, s.session_id),
                        format!("第 {} 纪元 · {}", s.context_epoch, s.cwd),
                    ));
                }
            }

            // Workbench Workstreams
            let agent_ws: Vec<_> = data
                .workstreams
                .iter()
                .filter(|w| &w.agent_id == sid)
                .collect();
            let mut ws_card = section_card().child(section_header(
                "Workbench 工作线",
                Some(
                    status_badge(format!("{} 条", agent_ws.len()), BadgeTone::Gold)
                        .into_any_element(),
                ),
            ));
            if agent_ws.is_empty() {
                ws_card = ws_card.child(empty_state(
                    "暂无进行中的工作线",
                    "完成阶段性目标后记录 checkpoint，换到另一台客户端就能直接无缝接着做。",
                ));
            } else {
                for ws in agent_ws.iter().take(5) {
                    let (st_label, tone) = match ws.status {
                        WorkstreamStatus::Active => ("进行中", BadgeTone::Success),
                        WorkstreamStatus::Paused => ("已暂停", BadgeTone::Warning),
                        WorkstreamStatus::Done => ("已完成", BadgeTone::Neutral),
                    };
                    ws_card = ws_card.child(
                        div()
                            .bg(colors::subtle())
                            .rounded(layout::radius_control())
                            .px(px(12.0))
                            .py(px(8.0))
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
                                                    "分支 {} · {}",
                                                    ws.branch_name, ws.updated_at
                                                )
                                            }),
                                    ),
                            )
                            .child(status_badge(st_label, tone)),
                    );
                }
            }

            // Reusable Workflows
            let agent_wfs: Vec<_> = data
                .workflows
                .iter()
                .filter(|w| &w.agent_id == sid)
                .collect();
            let mut wf_card = section_card().child(section_header(
                "可复用工作流（Workflow）",
                Some(
                    status_badge(format!("{} 个", agent_wfs.len()), BadgeTone::Neutral)
                        .into_any_element(),
                ),
            ));
            if agent_wfs.is_empty() {
                wf_card = wf_card.child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child("重复跑通的固定流程（如双端发版检查、回归验证）可以沉淀成这个 FULI Agent 的标准工作流。"),
                );
            } else {
                for (idx, wf) in agent_wfs.iter().take(4).enumerate() {
                    let wfid = wf.id.clone();
                    let right_el = if wf.status == WorkflowStatus::Proposed {
                        primary_button(format!("wf-approve-{idx}"), "确认启用", ControlSize::Sm)
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
                            format!("跑过 {} 次 · 成功 {}", wf.run_count, wf.pass_count),
                            BadgeTone::Success,
                        )
                        .into_any_element()
                    };
                    wf_card = wf_card.child(
                        div()
                            .bg(colors::subtle())
                            .rounded(layout::radius_control())
                            .px(px(12.0))
                            .py(px(8.0))
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
                    );
                }
            }

            detail_col = detail_col
                .child(sessions_card)
                .child(ws_card)
                .child(wf_card);
        } else {
            detail_col = detail_col.child(section_card().child(empty_state(
                "在左侧选一个 FULI Agent",
                "即可集中查看它绑定的仓库、所有客户端会话、工作线和工作流。",
            )));
        }

        div()
            .flex_1()
            .flex()
            .gap(px(18.0))
            .child(list_card)
            .child(detail_col)
    }

    // =========================================================================
    // View 3: Memory (知识库 | 个人与项目偏好)
    // =========================================================================

    fn render_memory(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let switcher = div()
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
            );

        let body = match self.memory_sub {
            MemorySubTab::Knowledge => self.render_memory_knowledge(cx),
            MemorySubTab::Rules => self.render_memory_rules(cx),
        };

        div()
            .flex_1()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(switcher)
            .child(body)
    }

    fn render_memory_knowledge(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let selected_kb = self
            .selected_kb_id
            .clone()
            .or_else(|| data.knowledge_bases.first().map(|k| k.id.clone()));

        let mut kb_list = section_card().w(px(300.0)).child(section_header(
            "知识库列表",
            Some(
                status_badge(
                    format!("{} 个", data.knowledge_bases.len()),
                    BadgeTone::Neutral,
                )
                .into_any_element(),
            ),
        ));

        for (idx, kb) in data.knowledge_bases.iter().enumerate() {
            let kid = kb.id.clone();
            let is_sel = selected_kb.as_deref() == Some(kid.as_str());
            let count = data.kb_items.iter().filter(|i| i.kb_id == kb.id).count();
            kb_list = kb_list.child(
                inset_list_row(
                    format!("kb-row-{idx}"),
                    kb.name.clone(),
                    format!("{count} 条知识 · 默认语言 {}", kb.default_lang),
                    is_sel,
                    None,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.selected_kb_id = Some(kid.clone());
                    cx.notify();
                })),
            );
        }

        // Cross-KB authorization summary
        if let Some(ref cur_kb) = selected_kb {
            let linked: Vec<_> = data
                .kb_links
                .iter()
                .filter(|lnk| {
                    &lnk.from_kb_id == cur_kb && lnk.authority == LinkAuthority::HumanConfirmed
                })
                .collect();
            kb_list = kb_list.child(
                div()
                    .pt(px(8.0))
                    .border_t_1()
                    .border_color(colors::border())
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(format!("已授权跨库引用（1–2 跳）：{} 条", linked.len())),
            );
        }

        let mut items_card = section_card().flex_1().child(section_header(
            "条目与复利反馈",
            Some(status_badge("支持中英双语检索", BadgeTone::Gold).into_any_element()),
        ));

        let filtered: Vec<_> = data
            .kb_items
            .iter()
            .filter(|i| selected_kb.as_deref().is_none_or(|k| i.kb_id == k))
            .collect();

        if filtered.is_empty() {
            items_card = items_card.child(empty_state(
                "这个知识库里还没有条目",
                "日常协作中沉淀的经验、排坑和决策都会按版本存到这里，旧版本永不覆盖丢失。",
            ));
        } else {
            for (idx, item) in filtered.iter().take(6).enumerate() {
                let id_help = item.id.clone();
                let id_stale = item.id.clone();
                let (st_label, tone) = match (item.status, item.needs_review) {
                    (KbItemStatus::Deprecated, _) => ("已废弃", BadgeTone::Neutral),
                    (KbItemStatus::Proposal, _) => ("待确认", BadgeTone::Warning),
                    (_, true) => ("可能过时", BadgeTone::Danger),
                    _ => ("已生效", BadgeTone::Success),
                };
                items_card =
                    items_card.child(
                        div()
                            .bg(colors::subtle())
                            .rounded(layout::radius_control())
                            .p(px(12.0))
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
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
                                    .child(item.body.chars().take(150).collect::<String>()),
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
                                                "复用 {} 次 · 有用 {} 次",
                                                item.reuse_count, item.helpful_count
                                            )),
                                    )
                                    .child(
                                        div()
                                            .flex()
                                            .gap(px(6.0))
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

        div()
            .flex_1()
            .flex()
            .gap(px(18.0))
            .child(kb_list)
            .child(items_card)
    }

    fn render_memory_rules(&self, cx: &mut Context<Self>) -> Div {
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
                          cx: &mut Context<Self>| {
            let mut card = section_card()
                .flex_1()
                .child(section_header(
                    title.to_string(),
                    Some(
                        status_badge(format!("{} 条", list.len()), BadgeTone::Neutral)
                            .into_any_element(),
                    ),
                ))
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(subtitle.to_string()),
                );
            if list.is_empty() {
                card = card.child(empty_state(
                    "暂时没有记下规矩或偏好",
                    "对话里直接说「记住以后都……」就会记到这里，软偏好永远盖不住红线规矩。",
                ));
            } else {
                for (idx, rule) in list.into_iter().take(6).enumerate() {
                    let rid = rule.id.clone();
                    let (badge, tone) = match rule.constraint_class {
                        ConstraintClass::HardRule => ("红线规矩", BadgeTone::Danger),
                        ConstraintClass::Preference => ("日常偏好", BadgeTone::Gold),
                    };
                    card = card.child(
                        div()
                            .bg(colors::subtle())
                            .rounded(layout::radius_control())
                            .p(px(12.0))
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(10.0))
                            .child(
                                div()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap(px(3.0))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.0))
                                            .child(status_badge(badge, tone))
                                            .child(
                                                div()
                                                    .text_size(typography::meta_size())
                                                    .text_color(colors::muted())
                                                    .child(rule.pref_key.clone()),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::body_size())
                                            .child(rule.content.clone()),
                                    ),
                            )
                            .child(
                                secondary_button(
                                    format!("{prefix}-off-{idx}"),
                                    "撤回",
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
                    );
                }
            }
            card
        };

        div()
            .flex_1()
            .flex()
            .gap(px(18.0))
            .child(render_col(
                "个人通用习惯（全项目生效）",
                "你的个人表达风格、排版审美、判断口味，切换任意项目都跟着你走。",
                personal,
                "personal",
                cx,
            ))
            .child(render_col(
                "当前项目规矩（按项目隔离）",
                "特定仓库的架构红线、分支规范、技术选型，绝不串台污染别的项目。",
                project,
                "project",
                cx,
            ))
    }

    // =========================================================================
    // View 4: Roundtable (轻量圆桌 — 跨客户端点名问答与收件箱)
    // =========================================================================

    fn render_roundtable(&self) -> Div {
        let data = &self.status.data;
        let mut card = section_card().flex_1().child(section_header(
            "轻量圆桌（跨客户端点名问询）",
            Some(
                status_badge(
                    format!("{} 条记录", data.roundtable.len()),
                    BadgeTone::Neutral,
                )
                .into_any_element(),
            ),
        ));

        if data.roundtable.is_empty() {
            card = card.child(empty_state(
                "还没有跨客户端问询记录",
                "当 Codex 向 Claude Code 发起只读问询（ask_agent）时，会按原生 Session ID 唤起或自动落入收件箱，零局域网广播开销。",
            ));
        } else {
            for ex in data.roundtable.iter().take(8) {
                let (st, tone) = match ex.wake_status {
                    WakeStatus::WokenReplied => ("已回复", BadgeTone::Success),
                    WakeStatus::QueuedInbox => ("待对方读取", BadgeTone::Warning),
                    WakeStatus::Failed => ("唤起失败", BadgeTone::Danger),
                };
                card = card.child(
                    div()
                        .bg(colors::subtle())
                        .rounded(layout::radius_control())
                        .p(px(12.0))
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
                                .child(format!("问：{}", ex.question)),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(match &ex.answer {
                                    Some(ans) => format!("答：{ans}"),
                                    None => "等待对方下一轮对话自动读取回复".to_string(),
                                }),
                        ),
                );
            }
        }

        div().flex_1().flex().child(card)
    }

    // =========================================================================
    // View 5: Delivery Inspector (交付透视镜 — 逐轮证明 0 重复注入)
    // =========================================================================

    fn render_inspector(&self) -> Div {
        let data = &self.status.data;
        let mut card = section_card().flex_1().child(section_header(
            "交付透视镜（每次给 AI 传了什么、省了什么）",
            Some(
                status_badge(
                    format!("累计省下 ~{} Token", data.tokens_saved),
                    BadgeTone::Success,
                )
                .into_any_element(),
            ),
        ));

        if data.deliveries.is_empty() {
            card = card.child(empty_state(
                "还没有交付记录",
                "一旦你在任意 AI 客户端发消息，这里就会逐条展示哪些规矩完整注入、哪些因为没变化而去重跳过。",
            ));
        } else {
            for rec in data.deliveries.iter().take(10) {
                let (mode_label, tone) = match rec.delivery_mode {
                    DeliveryMode::Full => ("完整下发", BadgeTone::Gold),
                    DeliveryMode::SkippedDedup => ("去重跳过", BadgeTone::Success),
                    DeliveryMode::DeltaRemoved => ("通知失效", BadgeTone::Warning),
                    DeliveryMode::TitleOnly => ("仅传标题", BadgeTone::Neutral),
                    DeliveryMode::TruncatedBudget => ("预算截断", BadgeTone::Danger),
                };
                card = card.child(
                    div()
                        .bg(colors::subtle())
                        .rounded(layout::radius_control())
                        .px(px(12.0))
                        .py(px(8.0))
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
                                            "{} · 第 {} 纪元第 {} 轮 · {}",
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
                                            "约 {} Token · v{}",
                                            rec.tokens_est, rec.target_revision
                                        )),
                                ),
                        )
                        .child(status_badge(mode_label, tone)),
                );
            }
        }

        div().flex_1().flex().child(card)
    }

    // =========================================================================
    // View 6: Settings (实时内存、自治度、中英切换、关窗释放显存)
    // =========================================================================

    fn render_settings(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let auto = data.autonomy_level;

        let telemetry_card = section_card()
            .flex_1()
            .child(section_header("本机进程与资源占用", None))
            .child(kv_row(
                "后台常驻进程（fuli-context）",
                if self.status.connected {
                    format!(
                        "{:.2} MiB 工作集 / {:.2} MiB 私有（PID {}）",
                        self.status.daemon_mem.working_set_mib(),
                        self.status.daemon_mem.private_mib(),
                        self.status.daemon_pid.unwrap_or(0)
                    )
                } else {
                    self.status.note.clone()
                },
            ))
            .child(kv_row(
                "当前桌面窗口（fuli-ui）",
                format!(
                    "{:.2} MiB 工作集（关闭窗口 {}s 后彻底退出归零）",
                    self.status.ui_mem.working_set_mib(),
                    self.close_grace_secs
                ),
            ))
            .child(kv_row(
                "本地 IPC 响应速度",
                format!(
                    "{:.2} ms · 后台已运行 {}s",
                    self.status.ipc_rtt_ms, self.status.uptime_secs
                ),
            ))
            .child(kv_row("唯一本地数据库", self.status.db_path.clone()))
            .child(
                div()
                    .pt(px(8.0))
                    .flex()
                    .gap(px(10.0))
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
            .flex_1()
            .child(section_header(l.t(CopyKey::AutonomyTitle), None))
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child("不管选哪一档，红线规矩冲突和删除操作永远先问你，任何自动操作都支持一键撤回。"),
            )
            .child(
                div()
                    .flex()
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
            .child(
                div()
                    .pt(px(10.0))
                    .border_t_1()
                    .border_color(colors::border())
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
                            .child(
                                segmented_tab("lang-zh", "中文", l == Locale::ZhCn).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.run_action(
                                            "set_locale",
                                            json!({ "locale": "zh-CN" }),
                                            "已切换为中文",
                                            cx,
                                        );
                                    }),
                                ),
                            )
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
            );

        div()
            .flex_1()
            .flex()
            .gap(px(18.0))
            .child(telemetry_card)
            .child(prefs_card)
    }
}

impl Render for FuliAppView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = self.locale();

        let content = match self.tab {
            NavTab::Today => self.render_today(cx),
            NavTab::Agents => self.render_agents(cx),
            NavTab::Memory => self.render_memory(cx),
            NavTab::Roundtable => self.render_roundtable(),
            NavTab::Inspector => self.render_inspector(),
            NavTab::Settings => self.render_settings(cx),
        };

        let mut root = div()
            .size_full()
            .bg(colors::canvas())
            .text_color(colors::ink())
            .flex()
            .flex_col()
            .relative()
            // Top bar: Brand + live dot + H1 + top-right Inspector / Settings / Refresh
            .child(
                div()
                    .h(px(56.0))
                    .px(px(24.0))
                    .border_b_1()
                    .border_color(colors::border())
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .text_size(typography::card_title_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .child(l.t(CopyKey::Brand)),
                            )
                            .child(div().size(px(8.0)).rounded(layout::radius_pill()).bg(
                                if self.status.connected {
                                    colors::success()
                                } else {
                                    colors::warning()
                                },
                            ))
                            .child(
                                div()
                                    .text_size(typography::title_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .child(self.page_heading()),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                segmented_tab(
                                    "top-inspector",
                                    l.t(CopyKey::NavInspector),
                                    self.tab == NavTab::Inspector,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Inspector, cx);
                                    },
                                )),
                            )
                            .child(
                                segmented_tab(
                                    "top-settings",
                                    l.t(CopyKey::NavSettings),
                                    self.tab == NavTab::Settings,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Settings, cx);
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "top-refresh",
                                    l.t(CopyKey::RefreshBtn),
                                    ControlSize::Sm,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.refresh(cx);
                                    },
                                )),
                            ),
                    ),
            );

        if let Some(ref msg) = self.toast {
            root = root.child(div().px(px(24.0)).pt(px(12.0)).child(notice_banner(
                BadgeTone::Success,
                "已更新",
                msg.clone(),
            )));
        }

        // Main workspace canvas
        root = root
            .child(
                div()
                    .flex_1()
                    .px(px(24.0))
                    .pt(px(18.0))
                    .pb(px(84.0))
                    .flex()
                    .child(content),
            )
            // Bottom floating capsule dock (4 clean core destinations)
            .child(
                div()
                    .absolute()
                    .bottom(px(18.0))
                    .left_0()
                    .right_0()
                    .flex()
                    .justify_center()
                    .child(
                        floating_dock()
                            .child(
                                dock_item(
                                    "dock-today",
                                    l.t(CopyKey::NavToday),
                                    self.tab == NavTab::Today,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Today, cx);
                                    },
                                )),
                            )
                            .child(
                                dock_item(
                                    "dock-agents",
                                    l.t(CopyKey::NavAgents),
                                    self.tab == NavTab::Agents,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Agents, cx);
                                    },
                                )),
                            )
                            .child(
                                dock_item(
                                    "dock-memory",
                                    l.t(CopyKey::NavMemory),
                                    self.tab == NavTab::Memory,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Memory, cx);
                                    },
                                )),
                            )
                            .child(
                                dock_item(
                                    "dock-roundtable",
                                    l.t(CopyKey::NavRoundtable),
                                    self.tab == NavTab::Roundtable,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Roundtable, cx);
                                    },
                                )),
                            ),
                    ),
            );

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

        let bounds = Bounds::centered(None, size(px(1160.0), px(760.0)), cx);
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
        let (window_handle, _view) = gpui_kit::open_window(options, cx, move |_window, cx| {
            cx.new(|_| FuliAppView::new(view_endpoint, close_grace_secs))
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
