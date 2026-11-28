#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Full Interactive Component & Motion Gallery for `fuli-ui-kit`.
//! Run with: `cargo run -p fuli-ui-kit --example gallery`

use std::time::Duration;

use fuli_ui_kit::{InputEvent, colors, *};
use gpui_kit::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GallerySection {
    BrandAndMotion,
    SelectAndForms,
    OverlaysAndTours,
    AvatarsAndLayouts,
    RichMotion,
}

#[derive(Debug, Clone)]
struct DemoToast {
    seq: u64,
    placement: ToastPlacement,
    tone: BadgeTone,
    title: String,
    detail: Option<String>,
    duration: Option<Duration>,
    with_undo: bool,
}

struct GalleryView {
    locale: Locale,
    section: GallerySection,
    active_dock: usize,

    // Inputs & Search
    sidebar_search: Entity<InputState>,
    search_input: Entity<InputState>,
    note_input: Entity<InputState>,
    search_result: String,

    // Selects & Comboboxes
    single_select: Entity<SingleSelectState>,
    searchable_select: Entity<SingleSelectState>,
    multi_select: Entity<MultiSelectState>,
    selected_single_label: String,
    selected_search_label: String,
    selected_multi_labels: Vec<String>,

    // Radio, Checkbox & Switch
    radio_mode: usize,
    checks: [bool; 3],
    switch_on: bool,
    copied: bool,
    collapsible_open: bool,

    // Overlays, Toasts & Guided Tour
    toast_seq: u64,
    active_toast: Option<DemoToast>,
    show_alert: bool,
    show_modal: bool,
    show_drawer: bool,
    tour_step: Option<usize>,

    // Rich motion components
    rich_switches: [bool; 3],
    rich_checks: [CheckState; 3],
    crumbs: Vec<String>,
    today: CalDate,
    cal_single: CalendarState,
    cal_range: CalendarState,
    rich_dialog_open: bool,
    rich_danger_open: bool,
    danger_ack: bool,
    rich_progress: f32,
    step_at: usize,
    timeline_open: Vec<bool>,

    _subscriptions: Vec<Subscription>,
}

impl GalleryView {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let sidebar_search =
            cx.new(|cx| InputState::new(window, cx).placeholder("搜索组件或动效..."));
        let search_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("支持原生中文输入法 (IME)，回车即查...")
        });
        let note_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("请输入规矩或备注...")
                .default_value("所有列表卡片禁止装饰性阴影")
        });

        let single_select = cx.new(|cx| {
            SelectState::new(
                select_options(["每次都问我", "给建议，我一键定", "常规事实自动记下"]),
                Some(IndexPath::new(1)),
                window,
                cx,
            )
        });

        let searchable_select = cx.new(|cx| {
            SelectState::new(
                select_options([
                    "FULI（主项目）",
                    "PhoneBridge（安卓控制）",
                    "fuli-avatar（头像生成器）",
                    "dingdong",
                    "flutter-adb-ai",
                    "compound-interest",
                    "shop-web",
                ]),
                Some(IndexPath::new(0)),
                window,
                cx,
            )
            .searchable(true)
        });

        let multi_select = cx.new(|cx| {
            ComboboxState::new(
                select_options(["Claude Code", "Codex", "Cursor", "OpenCode", "Antigravity"]),
                vec![IndexPath::new(0), IndexPath::new(1)],
                window,
                cx,
            )
            .multiple(true)
            .searchable(true)
        });

        let sub_search = cx.subscribe_in(
            &search_input,
            window,
            |this, state, ev: &InputEvent, _, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    let q = state.read(cx).value().to_string();
                    this.search_result = if q.trim().is_empty() {
                        "请输入关键词".into()
                    } else {
                        format!("已触发实时搜索：「{q}」")
                    };
                    cx.notify();
                }
            },
        );

        let sub_single = cx.subscribe_in(
            &single_select,
            window,
            |this, _, ev: &SelectEvent<StringSelectDelegate>, _, cx| {
                let SelectEvent::Confirm(val) = ev;
                this.selected_single_label = val
                    .as_ref()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "未选择".into());
                cx.notify();
            },
        );

        let sub_searchable = cx.subscribe_in(
            &searchable_select,
            window,
            |this, _, ev: &SelectEvent<StringSelectDelegate>, _, cx| {
                let SelectEvent::Confirm(val) = ev;
                this.selected_search_label = val
                    .as_ref()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "未选择".into());
                cx.notify();
            },
        );

        let sub_multi = cx.subscribe_in(
            &multi_select,
            window,
            |this, _, ev: &ComboboxEvent<StringSelectDelegate>, _, cx| match ev {
                ComboboxEvent::Change(vals) | ComboboxEvent::Confirm(vals) => {
                    this.selected_multi_labels = vals.iter().map(|s| s.to_string()).collect();
                    cx.notify();
                }
            },
        );

        Self {
            locale: Locale::ZhCn,
            section: GallerySection::BrandAndMotion,
            active_dock: 0,
            sidebar_search,
            search_input,
            note_input,
            search_result: "等待输入查询".into(),
            single_select,
            searchable_select,
            multi_select,
            selected_single_label: "给建议，我一键定".into(),
            selected_search_label: "FULI（主项目）".into(),
            selected_multi_labels: vec!["Claude Code".into(), "Codex".into()],
            radio_mode: 1,
            checks: [true, true, false],
            switch_on: true,
            copied: false,
            collapsible_open: true,
            toast_seq: 0,
            active_toast: None,
            show_alert: false,
            show_modal: false,
            show_drawer: false,
            tour_step: None,
            rich_switches: [true, false, true],
            rich_checks: [
                CheckState::Checked,
                CheckState::Unchecked,
                CheckState::Mixed,
            ],
            crumbs: vec![
                "我的空间".into(),
                "FULI".into(),
                "记忆库".into(),
                "发布规范".into(),
                "Runbook".into(),
                "v2 上线步骤".into(),
            ],
            today: CalDate::today_at_offset(8),
            cal_single: CalendarState::new(CalDate::today_at_offset(8), false),
            cal_range: CalendarState::new(CalDate::today_at_offset(8), true),
            rich_dialog_open: false,
            rich_danger_open: false,
            danger_ack: false,
            rich_progress: 0.42,
            step_at: 2,
            timeline_open: vec![false, true, false, false, false],
            _subscriptions: vec![sub_search, sub_single, sub_searchable, sub_multi],
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn show_toast(
        &mut self,
        placement: ToastPlacement,
        tone: BadgeTone,
        title: impl Into<String>,
        detail: Option<String>,
        auto_ms: Option<u64>,
        with_undo: bool,
        cx: &mut Context<Self>,
    ) {
        self.toast_seq += 1;
        let seq = self.toast_seq;
        let duration = auto_ms.map(Duration::from_millis);
        self.active_toast = Some(DemoToast {
            seq,
            placement,
            tone,
            title: title.into(),
            detail,
            duration,
            with_undo,
        });
        cx.notify();

        if let Some(dur) = duration {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(dur).await;
                let _ = this.update(cx, |view, cx| {
                    if view.active_toast.as_ref().is_some_and(|t| t.seq == seq) {
                        view.active_toast = None;
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }

    fn render_brand_and_motion(&self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(28.0))
            .child(
                section_card()
                    .child(section_header(
                        "官方品牌资产（Logo · 22.5% 应用图标 · 中英矢量字标）",
                        Some(status_badge("Brand v1.1", BadgeTone::Gold).into_any_element()),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(20.0))
                            .child(fuli_logo_mark(48.0))
                            .child(fuli_logo_mark(28.0))
                            .child(fuli_logo_mark(18.0))
                            .child(fuli_app_icon(48.0))
                            .child(fuli_wordmark_en(22.0))
                            .child(fuli_wordmark_zh(22.0)),
                    ),
            )
            .child(
                section_card()
                    .child(section_header(
                        "6 层原生复利 Loading 动效（2.2s 错峰生长 · 自动匹配光学切版）",
                        Some(status_badge("GPUI Native 120fps", BadgeTone::Success).into_any_element()),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(24.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_loading_mark("gl-page", LoadingSize::Page))
                                    .child(tag_chip("Page 48px")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_loading_mark("gl-compact", LoadingSize::Compact))
                                    .child(tag_chip("Compact 28px")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_loading_mark("gl-inline", LoadingSize::Inline))
                                    .child(tag_chip("Inline 16px Micro")),
                            )
                            .child(fuli_loading(
                                "gl-bar",
                                LoadingSize::Compact,
                                "正在把你的协作沉淀为复利…",
                            )),
                    ),
            )
            .child(
                section_card()
                    .child(section_header(
                        "FULI 大管家 Living Orb 流体光球（4 种运行态 + 迷你任务指示球）",
                        Some(status_badge("Concierge Orb", BadgeTone::Gold).into_any_element()),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(28.0))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_concierge_orb("gal-orb-idle", OrbState::Idle, 64.0))
                                    .child(tag_chip("Idle · 柔和呼吸")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_concierge_orb(
                                        "gal-orb-route",
                                        OrbState::Routing,
                                        64.0,
                                    ))
                                    .child(tag_chip("Routing · 识别路由")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_concierge_orb(
                                        "gal-orb-run",
                                        OrbState::Running,
                                        64.0,
                                    ))
                                    .child(tag_chip("Running · 任务运行")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .items_center()
                                    .gap(px(6.0))
                                    .child(fuli_concierge_orb(
                                        "gal-orb-attn",
                                        OrbState::Attention,
                                        64.0,
                                    ))
                                    .child(tag_chip("Attention · 待确认")),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.0))
                                    .px(px(12.0))
                                    .py(px(8.0))
                                    .rounded(layout::radius_pill())
                                    .bg(colors::subtle())
                                    .border_1()
                                    .border_color(colors::border())
                                    .child(orb_mini_indicator("gal-mini-run", true))
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::ink())
                                            .child("1 个任务运行中"),
                                    ),
                            ),
                    ),
            )
            .child(
                section_card()
                    .child(section_header(
                        "物理弹簧与自然动效（支持半路打断速度保留 & 系统减弱动效）",
                        Some(
                            secondary_button(
                                "btn-toggle-collapse",
                                if self.collapsible_open {
                                    "收起弹簧面板"
                                } else {
                                    "展开弹簧面板"
                                },
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.collapsible_open = !this.collapsible_open;
                                cx.notify();
                            }))
                            .into_any_element(),
                        ),
                    ))
                    .child(collapsible_reveal(
                        "gal-spring-panel",
                        self.collapsible_open,
                        inset_panel()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(14.0))
                                    .child(fuli_avatar(
                                        "gm-av",
                                        "FULI",
                                        AvatarSize::Lg,
                                        AvatarPresence::Working,
                                    ))
                                    .child(
                                        div()
                                            .flex_1()
                                            .flex()
                                            .flex_col()
                                            .gap(px(4.0))
                                            .child(
                                                div()
                                                    .flex()
                                                    .items_center()
                                                    .gap(px(8.0))
                                                    .child(live_pulse_dot("gm-dot", 8.0, colors::success()))
                                                    .child(
                                                        div()
                                                            .text_size(typography::body_size())
                                                            .font_weight(typography::WEIGHT_MEDIUM)
                                                            .child("活跃呼吸环 + 状态脉动 + 弹簧平滑展开"),
                                                    ),
                                            )
                                            .child(
                                                div()
                                                    .text_size(typography::meta_size())
                                                    .text_color(colors::muted())
                                                    .child("点击左下角悬浮胶囊里的 5 个图标，感受平移自 v0.29 的金色小圆点物理弹簧滑行；快速连点也会保留速度自然拐弯。"),
                                            ),
                                    ),
                            )
                            .into_any_element(),
                    ))
                    .child(divider())
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(10.0))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(12.0))
                                    .child(
                                        div()
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .text_color(colors::ink())
                                            .child("Apple 风格物理弹簧分段器 & 平滑进度条（连点感受速度保留）"),
                                    )
                                    .child(spring_segmented_control(
                                        "gal-seg-spring",
                                        self.radio_mode,
                                        92.0,
                                        vec![
                                            spring_segment_slot("gseg-0", "轻量 33%", 92.0, self.radio_mode == 0)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.radio_mode = 0;
                                                    cx.notify();
                                                }))
                                                .into_any_element(),
                                            spring_segment_slot("gseg-1", "均衡 66%", 92.0, self.radio_mode == 1)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.radio_mode = 1;
                                                    cx.notify();
                                                }))
                                                .into_any_element(),
                                            spring_segment_slot("gseg-2", "满载 100%", 92.0, self.radio_mode == 2)
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.radio_mode = 2;
                                                    cx.notify();
                                                }))
                                                .into_any_element(),
                                        ],
                                    )),
                            )
                            .child(progress_bar_animated(
                                "gal-spring-bar",
                                match self.radio_mode {
                                    0 => 0.33,
                                    1 => 0.66,
                                    _ => 1.0,
                                },
                                colors::gold(),
                            )),
                    ),
            )
    }

    fn render_select_and_forms(&self, cx: &mut Context<Self>) -> Div {
        let all_checked = self.checks.iter().all(|&c| c);
        let any_checked = self.checks.iter().any(|&c| c);
        let indeterminate = any_checked && !all_checked;

        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(28.0))
            .child(
                section_card()
                    .child(section_header(
                        "下拉选择家族（单选 · 可搜索单选 · 下拉多选）",
                        Some(
                            status_badge("键盘上下 + Esc + 高亮匹配", BadgeTone::Gold)
                                .into_any_element(),
                        ),
                    ))
                    .child(
                        div()
                            .flex()
                            .gap(px(14.0))
                            .child(div().flex_1().child(form_field(
                                "下拉单选（Select）",
                                Some(format!("当前选中：{}", self.selected_single_label).into()),
                                select_single(
                                    &self.single_select,
                                    "请选择自主级别",
                                    ControlSize::Md,
                                ),
                            )))
                            .child(div().flex_1().child(form_field(
                                "下拉可搜索单选（Searchable Select）",
                                Some(format!("当前项目：{}", self.selected_search_label).into()),
                                select_searchable(
                                    &self.searchable_select,
                                    "选择关联项目",
                                    "输入项目名即时过滤...",
                                    ControlSize::Md,
                                ),
                            ))),
                    )
                    .child(form_field(
                        "下拉多选带搜索（Multi-Select Combobox）",
                        Some(
                            format!(
                                "已选 {} 项：{}",
                                self.selected_multi_labels.len(),
                                if self.selected_multi_labels.is_empty() {
                                    "无".into()
                                } else {
                                    self.selected_multi_labels.join(" · ")
                                }
                            )
                            .into(),
                        ),
                        select_multi(
                            &self.multi_select,
                            "选择要生效的 AI 客户端（可多选）",
                            "搜索客户端名...",
                            ControlSize::Md,
                        ),
                    )),
            )
            .child(
                div()
                    .flex()
                    .gap(px(16.0))
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("单选组（Radio Group）", None))
                            .child(radio_group(
                                false,
                                vec![
                                    radio_item(
                                        "gal-r-0",
                                        "每次都问我",
                                        Some("最稳妥，所有新提议等你确认后才生效".into()),
                                        self.radio_mode == 0,
                                        cx.listener(|this, _, _, cx| {
                                            this.radio_mode = 0;
                                            cx.notify();
                                        }),
                                    ),
                                    radio_item(
                                        "gal-r-1",
                                        "给建议，我一键定（推荐）",
                                        Some("常规内容整理好放到「等你拍板」".into()),
                                        self.radio_mode == 1,
                                        cx.listener(|this, _, _, cx| {
                                            this.radio_mode = 1;
                                            cx.notify();
                                        }),
                                    ),
                                    radio_item(
                                        "gal-r-2",
                                        "常规事实自动记下",
                                        Some("随时可一键撤回；红线冲突永远先问你".into()),
                                        self.radio_mode == 2,
                                        cx.listener(|this, _, _, cx| {
                                            this.radio_mode = 2;
                                            cx.notify();
                                        }),
                                    ),
                                ],
                            )),
                    )
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("多选组（Checkbox + 半选态）", None))
                            .child(checkbox_group(
                                false,
                                vec![
                                    checkbox_item(
                                        "gal-cb-all",
                                        "全选同步维度",
                                        Some("支持半选（indeterminate）状态自动联动".into()),
                                        all_checked,
                                        indeterminate,
                                        cx.listener(|this, checked: &bool, _, cx| {
                                            this.checks = [*checked, *checked, *checked];
                                            cx.notify();
                                        }),
                                    ),
                                    checkbox_item(
                                        "gal-cb-0",
                                        "同步红线规矩与偏好",
                                        None,
                                        self.checks[0],
                                        false,
                                        cx.listener(|this, checked: &bool, _, cx| {
                                            this.checks[0] = *checked;
                                            cx.notify();
                                        }),
                                    ),
                                    checkbox_item(
                                        "gal-cb-1",
                                        "同步跨项目关联授权",
                                        None,
                                        self.checks[1],
                                        false,
                                        cx.listener(|this, checked: &bool, _, cx| {
                                            this.checks[1] = *checked;
                                            cx.notify();
                                        }),
                                    ),
                                    checkbox_item(
                                        "gal-cb-2",
                                        "包含待确认建议草稿",
                                        None,
                                        self.checks[2],
                                        false,
                                        cx.listener(|this, checked: &bool, _, cx| {
                                            this.checks[2] = *checked;
                                            cx.notify();
                                        }),
                                    ),
                                ],
                            )),
                    ),
            )
            .child(
                section_card()
                    .child(section_header(
                        "输入框、搜索框、开关行与统一按钮尺度（30 / 36 / 44px）",
                        Some(
                            status_badge(self.search_result.clone(), BadgeTone::Success)
                                .into_any_element(),
                        ),
                    ))
                    .child(search_bar(
                        &self.search_input,
                        primary_button("g-s-go", "搜索", ControlSize::Md)
                            .on_click(cx.listener(|this, _, _, cx| {
                                let q = this.search_input.read(cx).value().to_string();
                                this.search_result = if q.trim().is_empty() {
                                    "请输入关键词".into()
                                } else {
                                    format!("已搜索：「{q}」")
                                };
                                cx.notify();
                            }))
                            .into_any_element(),
                        Some(
                            secondary_button("g-s-clr", "清空", ControlSize::Md)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.search_input
                                        .update(cx, |s, cx| s.set_value("", window, cx));
                                    this.search_result = "已清空".into();
                                    cx.notify();
                                }))
                                .into_any_element(),
                        ),
                    ))
                    .child(form_field(
                        "原生中英 IME 文本输入框",
                        None,
                        text_input(&self.note_input, ControlSize::Md).into_any_element(),
                    ))
                    .child(setting_toggle_row(
                        "g-sw-1",
                        "自动记录稳定偏好",
                        "符合 v0.27.16 设置页风格的墨黑开关行",
                        self.switch_on,
                        cx.listener(|this, checked: &bool, _, cx| {
                            this.switch_on = *checked;
                            cx.notify();
                        }),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(8.0))
                            .child(primary_button("gb-sm", "Sm 30px", ControlSize::Sm))
                            .child(primary_button("gb-md", "Md 36px", ControlSize::Md))
                            .child(primary_button("gb-lg", "Lg 44px", ControlSize::Lg))
                            .child(secondary_button("gb-sec", "次按钮", ControlSize::Md))
                            .child(ghost_button("gb-gh", "静默按钮", ControlSize::Md))
                            .child(danger_button("gb-dn", "危险操作", ControlSize::Md))
                            .child(
                                copy_button(
                                    "gb-cp",
                                    "一键复制",
                                    "已复制",
                                    self.copied,
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            "fuli setup --client claude-code --apply".into(),
                                        ));
                                        this.copied = true;
                                        this.show_toast(
                                            ToastPlacement::TopCenter,
                                            BadgeTone::Success,
                                            "已复制接入命令到剪贴板",
                                            None,
                                            Some(3200),
                                            false,
                                            cx,
                                        );
                                    },
                                )),
                            ),
                    ),
            )
    }

    fn render_overlays_and_tours(&self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(28.0))
            .child(
                section_card()
                    .child(section_header(
                        "定时自动消失提醒（顶部 · 右上 · 底部 · 带撤销按钮与倒计时条）",
                        Some(
                            status_badge("弹簧滑入 + 3.5s 自动消失", BadgeTone::Gold)
                                .into_any_element(),
                        ),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(10.0))
                            .child(
                                primary_button(
                                    "t-top-c",
                                    "顶部居中提醒（3.5s 消失）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_toast(
                                            ToastPlacement::TopCenter,
                                            BadgeTone::Success,
                                            "已把新规矩写入本地知识库",
                                            Some("下次打开 Claude Code / Codex 会自动生效".into()),
                                            Some(3500),
                                            false,
                                            cx,
                                        );
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "t-top-r",
                                    "右上提醒（带「撤销」）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_toast(
                                            ToastPlacement::TopRight,
                                            BadgeTone::Gold,
                                            "已归档 1 条过时经验",
                                            Some("历史版本依然完整保留，可随时撤回".into()),
                                            Some(4500),
                                            true,
                                            cx,
                                        );
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "t-bot-c",
                                    "底部居中提醒（3.5s 消失）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_toast(
                                            ToastPlacement::BottomCenter,
                                            BadgeTone::Neutral,
                                            "已完成零模型本地体检",
                                            Some("发现 1 处规则冲突，其余一切清爽".into()),
                                            Some(3500),
                                            false,
                                            cx,
                                        );
                                    },
                                )),
                            )
                            .child(
                                danger_button(
                                    "t-bot-r",
                                    "底部危险警示（不自动消失）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_toast(
                                            ToastPlacement::BottomRight,
                                            BadgeTone::Danger,
                                            "检测到两条红线规矩互相冲突",
                                            Some("需要你亲自二选一后才会下发给 AI".into()),
                                            None,
                                            false,
                                            cx,
                                        );
                                    },
                                )),
                            ),
                    ),
            )
            .child(
                section_card()
                    .child(section_header(
                        "多形态弹窗与引导式气泡（Alert · Modal · Drawer · Guided Tour）",
                        None,
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(10.0))
                            .child(
                                primary_button(
                                    "ov-tour",
                                    "启动 3 步引导式弹窗（Guided Tour）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.tour_step = Some(0);
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "ov-alert",
                                    "打开提醒确认弹窗（Alert）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_alert = true;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "ov-modal",
                                    "打开居中表单弹窗（Modal）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_modal = true;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                secondary_button(
                                    "ov-drawer",
                                    "打开右侧滑入抽屉（Drawer）",
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.show_drawer = true;
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
    }

    fn render_avatars_and_layouts(&self) -> Div {
        let team = vec![
            "FULI".to_string(),
            "PhoneBridge".to_string(),
            "dingdong".to_string(),
            "fuli-avatar".to_string(),
            "shop-web".to_string(),
        ];
        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(28.0))
            .child(
                section_card()
                    .child(section_header(
                        "确定性头像、工作态呼吸光环与协作堆叠组",
                        Some(status_badge("同名字永远同色", BadgeTone::Neutral).into_any_element()),
                    ))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap(px(18.0))
                            .child(fuli_avatar(
                                "av-1",
                                "FULI",
                                AvatarSize::Lg,
                                AvatarPresence::Working,
                            ))
                            .child(fuli_avatar(
                                "av-2",
                                "PhoneBridge",
                                AvatarSize::Lg,
                                AvatarPresence::Online,
                            ))
                            .child(fuli_avatar(
                                "av-3",
                                "潮池账本",
                                AvatarSize::Md,
                                AvatarPresence::Attention,
                            ))
                            .child(fuli_avatar(
                                "av-4",
                                "dingdong",
                                AvatarSize::Sm,
                                AvatarPresence::None,
                            ))
                            .child(div().w(px(1.0)).h(px(28.0)).bg(colors::border()))
                            .child(avatar_group("gal-grp", &team, 4, AvatarSize::Md)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .gap(px(16.0))
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("极简复利折线与 2+1 指标卡", None))
                            .child(sparkline_line(&[2, 5, 11, 24, 52, 74, 85], 115.0))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(10.0))
                                    .child(stat_tile("85", "攒下的习惯和经验", "最近 7 周持续积累"))
                                    .child(stat_tile(
                                        "10.5 MiB",
                                        "纯 Rust 常驻内存",
                                        "关窗显存自动归零",
                                    )),
                            ),
                    )
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("红线冲突二选一卡与骨架屏", None))
                            .child(conflict_split_card(
                                "规矩打架了：git-branch-naming",
                                "两条红线规矩互相矛盾，需要你二选一。",
                                inset_panel()
                                    .flex_1()
                                    .child("全局分支用 JVS/ 前缀")
                                    .child(primary_button("g-c-l", "留这条", ControlSize::Sm))
                                    .into_any_element(),
                                inset_panel()
                                    .flex_1()
                                    .child("FULI 仓库用 next/*")
                                    .child(primary_button("g-c-r", "留这条", ControlSize::Sm))
                                    .into_any_element(),
                            ))
                            .child(skeleton_card()),
                    ),
            )
    }
}

impl GalleryView {
    fn rich_card(title: &str, badge: &str, body: AnyElement) -> Div {
        section_card()
            .child(section_header(
                title.to_string(),
                Some(status_badge(badge.to_string(), BadgeTone::Neutral).into_any_element()),
            ))
            .child(body)
    }

    fn render_rich_motion(&mut self, cx: &mut Context<Self>) -> Div {
        // 1. Tooltip
        let tooltip_demo = div()
            .flex()
            .gap(px(10.0))
            .child(with_tooltip(
                secondary_button("rt-tip-1", "悬停我", ControlSize::Md),
                "这是 FULI 的轻提示",
                Some("停留 0.3 秒出现，弹簧淡入，移开就收起".into()),
            ))
            .child(
                top_icon_button("rt-tip-2", "zap", false)
                    .tooltip(fuli_tooltip("立即整理", None, Some("⌘R".into())))
                    .tooltip_show_delay(Duration::from_millis(280)),
            )
            .into_any_element();

        // 7. FLA hover card
        let fla = FlaProfile {
            name: "Milo Reed".into(),
            role: "FULI 项目组长 · 实现".into(),
            presence: AvatarPresence::Working,
            status_label: "工作中".into(),
            doing: vec![
                "修 macOS Hook stdin 注入".into(),
                "做 FULI 运行日志时间线".into(),
                "复核 Windows 新提交 e34509965".into(),
            ],
            actions: vec!["发消息".into(), "看工作线".into(), "复制续接命令".into()],
        };
        let hover_demo = div()
            .flex()
            .items_center()
            .gap(px(14.0))
            .child(with_fla_hover_card(
                div()
                    .id("rt-fla")
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .py(px(6.0))
                    .rounded(layout::radius_control())
                    .hover(|s| s.bg(colors::hover()))
                    .child(fuli_avatar(
                        "rt-fla-av",
                        "Milo Reed",
                        AvatarSize::Md,
                        AvatarPresence::Working,
                    ))
                    .child(
                        div()
                            .text_size(typography::body_size())
                            .text_color(colors::ink())
                            .child("Milo Reed"),
                    ),
                fla,
                None,
            ))
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child("悬停头像或名字，浮出人物卡；鼠标可以移进卡片点按钮"),
            )
            .into_any_element();

        // 2. Switch
        let labels = ["自动记下常规事实", "允许圆桌唤起", "禁用示例"];
        let mut switches = div().flex().flex_col().gap(px(12.0));
        for (i, label) in labels.iter().enumerate() {
            switches = switches.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .w(px(320.0))
                    .child(
                        div()
                            .text_size(typography::body_size())
                            .text_color(colors::ink())
                            .child(*label),
                    )
                    .child(fuli_switch(
                        format!("rt-sw-{i}"),
                        self.rich_switches[i],
                        i == 2,
                        cx.listener(move |this, v: &bool, _, cx| {
                            this.rich_switches[i] = *v;
                            cx.notify();
                        }),
                    )),
            );
        }

        // 3. Checkbox
        let check_labels = [
            ("同步红线规矩", Some("确认后对所有项目生效")),
            ("同步跨项目授权", None),
            ("全部选项（半选态）", Some("子项部分选中时显示一条横线")),
        ];
        let mut checks = div().flex().flex_col().gap(px(10.0));
        for (i, (label, sub)) in check_labels.iter().enumerate() {
            checks = checks.child(fuli_checkbox(
                format!("rt-cb-{i}"),
                *label,
                sub.map(SharedString::from),
                self.rich_checks[i],
                false,
                cx.listener(move |this, v: &bool, _, cx| {
                    this.rich_checks[i] = if *v {
                        CheckState::Checked
                    } else {
                        CheckState::Unchecked
                    };
                    cx.notify();
                }),
            ));
        }

        // 4. Breadcrumb
        let crumb_items: Vec<SharedString> = self.crumbs.iter().map(|c| c.clone().into()).collect();
        let breadcrumb_demo = div()
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(fuli_breadcrumb(
                "rt-bc",
                crumb_items,
                4,
                cx.listener(|this, idx: &usize, _, cx| {
                    this.crumbs.truncate(idx + 1);
                    cx.notify();
                }),
            ))
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        secondary_button("rt-bc-add", "往下一层", ControlSize::Sm).on_click(
                            cx.listener(|this, _, _, cx| {
                                let n = this.crumbs.len();
                                this.crumbs.push(format!("第 {} 层", n + 1));
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        ghost_button("rt-bc-reset", "重置", ControlSize::Sm).on_click(cx.listener(
                            |this, _, _, cx| {
                                this.crumbs = [
                                    "我的空间",
                                    "FULI",
                                    "记忆库",
                                    "发布规范",
                                    "Runbook",
                                    "v2 上线步骤",
                                ]
                                .iter()
                                .map(|s| s.to_string())
                                .collect();
                                cx.notify();
                            },
                        )),
                    ),
            )
            .into_any_element();

        // 5. Calendar
        let calendar_demo = div()
            .flex()
            .flex_wrap()
            .gap(px(16.0))
            .child(fuli_calendar(
                "rt-cal-1",
                &self.cal_single,
                self.today,
                cx.listener(|this, d: &i32, _, cx| {
                    this.cal_single.shift_month(*d);
                    cx.notify();
                }),
                cx.listener(|this, date: &CalDate, _, cx| {
                    this.cal_single.pick(*date);
                    cx.notify();
                }),
            ))
            .child(fuli_calendar(
                "rt-cal-2",
                &self.cal_range,
                self.today,
                cx.listener(|this, d: &i32, _, cx| {
                    this.cal_range.shift_month(*d);
                    cx.notify();
                }),
                cx.listener(|this, date: &CalDate, _, cx| {
                    this.cal_range.pick(*date);
                    cx.notify();
                }),
            ))
            .into_any_element();

        // 6. Dialog triggers
        let dialog_demo = div()
            .flex()
            .gap(px(10.0))
            .child(
                primary_button("rt-dlg-open", "打开完整对话框", ControlSize::Md).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.rich_dialog_open = true;
                        cx.notify();
                    }),
                ),
            )
            .child(
                danger_button("rt-dlg-danger", "危险确认对话框", ControlSize::Md).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.rich_danger_open = true;
                        this.danger_ack = false;
                        cx.notify();
                    }),
                ),
            )
            .into_any_element();

        // 8. Progress
        let progress_demo = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .w(px(460.0))
            .child(fuli_progress(
                "rt-pg-1",
                ProgressValue::Determinate(self.rich_progress),
                Some("导入旧版知识".into()),
                true,
                BadgeTone::Neutral,
            ))
            .child(fuli_progress(
                "rt-pg-2",
                ProgressValue::Indeterminate,
                Some("正在找相关知识".into()),
                true,
                BadgeTone::Gold,
            ))
            .child(segmented_progress(
                "rt-pg-3",
                vec![
                    ProgressSegment {
                        label: "已确认".into(),
                        ratio: 0.62,
                        tone: BadgeTone::Success,
                    },
                    ProgressSegment {
                        label: "待拍板".into(),
                        ratio: 0.23,
                        tone: BadgeTone::Gold,
                    },
                    ProgressSegment {
                        label: "已过时".into(),
                        ratio: 0.15,
                        tone: BadgeTone::Danger,
                    },
                ],
                true,
            ))
            .child(
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        secondary_button("rt-pg-dec", "-20%", ControlSize::Sm).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.rich_progress = (this.rich_progress - 0.2).max(0.0);
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        secondary_button("rt-pg-inc", "+20%", ControlSize::Sm).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.rich_progress = (this.rich_progress + 0.2).min(1.0);
                                cx.notify();
                            }),
                        ),
                    ),
            )
            .into_any_element();

        // 9. Steps
        let step_titles = [
            ("录入需求", "PRD 与截止日期"),
            ("评审排期", "产品开发测试共同定"),
            ("开发联调", "本机或公共执行"),
            ("测试验收", "自动化 + 真机"),
            ("上线确认", "产品开发拍板"),
        ];
        let steps: Vec<StepItem> = step_titles
            .iter()
            .enumerate()
            .map(|(i, (t, d))| {
                let status = match i.cmp(&self.step_at) {
                    std::cmp::Ordering::Less => StepStatus::Done,
                    std::cmp::Ordering::Equal => StepStatus::Current,
                    std::cmp::Ordering::Greater => StepStatus::Pending,
                };
                StepItem::new(*t, status).description(*d)
            })
            .collect();
        let steps_demo =
            div()
                .flex()
                .flex_col()
                .gap(px(18.0))
                .child(fuli_steps("rt-steps-h", &steps, false))
                .child(
                    div()
                        .flex()
                        .gap(px(24.0))
                        .child(
                            div()
                                .w(px(260.0))
                                .child(fuli_steps("rt-steps-v", &steps, true)),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .child(
                                    secondary_button("rt-st-prev", "上一步", ControlSize::Sm)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.step_at = this.step_at.saturating_sub(1);
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    primary_button("rt-st-next", "下一步", ControlSize::Sm)
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.step_at = (this.step_at + 1).min(5);
                                            cx.notify();
                                        })),
                                ),
                        ),
                )
                .into_any_element();

        // 10. Timeline (FULI run log preview)
        let mono = |t: &str| {
            div()
                .text_size(typography::meta_size())
                .text_color(colors::ink())
                .child(t.to_string())
                .into_any_element()
        };
        let o = &self.timeline_open;
        let entries = vec![
            TimelineEntry::new("Hook", BadgeTone::Neutral, "收到 Claude Code 提问")
                .subtitle("session 5e41…85b2 · cwd ~/workspace/fuli")
                .time("04:12:08.231")
                .duration("0.2 ms")
                .detail(mono("UserPromptSubmit · prompt 38 字"))
                .expanded(o[0]),
            TimelineEntry::new(
                "项目",
                BadgeTone::Gold,
                "按目录认出 FULI Bot「复利（Fuli）」",
            )
            .subtitle("git remote 匹配 github.com/JevonsCode/fuli")
            .time("04:12:08.232")
            .duration("0.4 ms")
            .detail(mono("绑定方式：git_remote · 分支 next"))
            .expanded(o[1]),
            TimelineEntry::new("规矩", BadgeTone::Success, "下发红线 1 条，去重跳过 3 条")
                .subtitle("约 40 token · 节省 120 token")
                .time("04:12:08.233")
                .duration("0.3 ms")
                .detail(mono("• macOS 联调测试：每次回复开头先写「复利」"))
                .expanded(o[2]),
            TimelineEntry::new(
                "检索",
                BadgeTone::Warning,
                "search_knowledge「活动承接 排期」命中 3 条",
            )
            .subtitle("授权知识库 2 个 · 785 B")
            .time("04:12:09.014")
            .duration("1.8 ms")
            .detail(mono(
                "1. 活动承接暂定分工…  2. 业务地区按 locale…  3. 新需求缺分工时…",
            ))
            .expanded(o[3]),
            TimelineEntry::new("返回", BadgeTone::Neutral, "注入给模型 additionalContext")
                .subtitle("本轮共 2.7 ms")
                .time("04:12:09.016")
                .duration("2.7 ms")
                .detail(mono("hookSpecificOutput.additionalContext · 98 字"))
                .expanded(o[4]),
        ];
        let timeline_demo = div()
            .w(px(620.0))
            .child(fuli_timeline(
                "rt-tl",
                entries,
                cx.listener(|this, idx: &usize, _, cx| {
                    if let Some(v) = this.timeline_open.get_mut(*idx) {
                        *v = !*v;
                    }
                    cx.notify();
                }),
            ))
            .into_any_element();

        div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(28.0))
            .child(Self::rich_card(
                "悬停提示 Tooltip",
                "延迟 0.3s · 弹簧淡入",
                tooltip_demo,
            ))
            .child(Self::rich_card(
                "FULI Bot 人物卡 Hover Card",
                "可移入点按钮",
                hover_demo,
            ))
            .child(Self::rich_card(
                "开关 Switch",
                "滑块弹簧 + 底色过渡",
                switches.into_any_element(),
            ))
            .child(Self::rich_card(
                "复选 Checkbox",
                "勾号自己画出来",
                checks.into_any_element(),
            ))
            .child(Self::rich_card(
                "面包屑 Breadcrumb",
                "超过 4 层自动折叠",
                breadcrumb_demo,
            ))
            .child(Self::rich_card(
                "日历 Calendar",
                "单选 / 区间 · 切月滑动",
                calendar_demo,
            ))
            .child(Self::rich_card(
                "对话框 Dialog",
                "进出都有弹簧",
                dialog_demo,
            ))
            .child(Self::rich_card(
                "进度条 Progress",
                "确定 / 不确定 / 分段",
                progress_demo,
            ))
            .child(Self::rich_card(
                "步骤条 Steps",
                "横竖两种 · 当前步呼吸",
                steps_demo,
            ))
            .child(Self::rich_card(
                "时间线 Timeline",
                "FULI 运行日志预览",
                timeline_demo,
            ))
    }

    fn render_rich_dialogs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let mut scroll_content = div();
        for i in 1..=8 {
            scroll_content = scroll_content.child(dialog_kv(
                format!("第 {i} 条知识"),
                format!("活动承接规则 {i} · 已确认"),
            ));
        }
        let body = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(dialog_section(
                "基本信息",
                vec![
                    dialog_field(
                        "项目名称",
                        false,
                        None,
                        text_input(&self.note_input, ControlSize::Md).into_any_element(),
                    ),
                    dialog_field(
                        "绑定目录",
                        true,
                        Some("例如 ~/workspace/fuli".into()),
                        div()
                            .h(px(36.0))
                            .rounded(layout::radius_control())
                            .border_1()
                            .border_color(colors::control_border())
                            .into_any_element(),
                    ),
                ],
            ))
            .child(divider())
            .child(dialog_callout(
                BadgeTone::Gold,
                "会从旧版迁移 99 条知识",
                Some("只复制，旧版数据不会被改动".into()),
            ))
            .child(dialog_section(
                "将要导入（可滚动）",
                vec![dialog_scroll_body("rt-dlg-scroll", 140.0, scroll_content)],
            ))
            .into_any_element();
        let footer = dialog_footer(
            Some(
                fuli_checkbox(
                    "rt-dlg-remember",
                    "下次不再提醒",
                    None,
                    CheckState::Unchecked,
                    false,
                    |_, _, _| {},
                )
                .into_any_element(),
            ),
            vec![
                secondary_button("rt-dlg-cancel", "取消", ControlSize::Md)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.rich_dialog_open = false;
                        cx.notify();
                    }))
                    .into_any_element(),
                primary_button("rt-dlg-ok", "开始导入", ControlSize::Md)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.rich_dialog_open = false;
                        cx.notify();
                    }))
                    .into_any_element(),
            ],
        );
        let normal = fuli_dialog(
            "rt-dialog",
            self.rich_dialog_open,
            DialogTone::Normal,
            "迁移旧版知识",
            Some("把旧电脑上的 FULI、DINGDONG、活动承接复制过来测试".into()),
            body,
            footer,
            520.0,
            cx.listener(|this, _: &(), _, cx| {
                this.rich_dialog_open = false;
                cx.notify();
            }),
        );

        let ack = self.danger_ack;
        let danger_body = div()
            .flex()
            .flex_col()
            .gap(px(12.0))
            .child(dialog_callout(
                BadgeTone::Danger,
                "删除后没法撤回",
                Some("这个 FULI Bot 的 44 条知识和 3 条工作线会一起删掉".into()),
            ))
            .child(dialog_kv("FULI Bot", "DingDongBuddy"))
            .child(dialog_kv("知识", "44 条"))
            .child(fuli_checkbox(
                "rt-danger-ack",
                "我知道这一步不能撤回",
                None,
                if ack {
                    CheckState::Checked
                } else {
                    CheckState::Unchecked
                },
                false,
                cx.listener(|this, v: &bool, _, cx| {
                    this.danger_ack = *v;
                    cx.notify();
                }),
            ))
            .into_any_element();
        let delete_btn = danger_button("rt-danger-ok", "删除", ControlSize::Md);
        let delete_btn = if ack {
            delete_btn.on_click(cx.listener(|this, _, _, cx| {
                this.rich_danger_open = false;
                cx.notify();
            }))
        } else {
            delete_btn.opacity(0.45)
        };
        let danger_footer = dialog_footer(
            None,
            vec![
                secondary_button("rt-danger-cancel", "先不删", ControlSize::Md)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.rich_danger_open = false;
                        cx.notify();
                    }))
                    .into_any_element(),
                delete_btn.into_any_element(),
            ],
        );
        let danger = fuli_dialog(
            "rt-danger",
            self.rich_danger_open,
            DialogTone::Danger,
            "删除 DingDongBuddy？",
            None,
            danger_body,
            danger_footer,
            440.0,
            cx.listener(|this, _: &(), _, cx| {
                this.rich_danger_open = false;
                cx.notify();
            }),
        );
        div()
            .absolute()
            .inset_0()
            .child(normal)
            .child(danger)
            .into_any_element()
    }
}

impl Render for GalleryView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = self.locale;

        let sidebar = sidebar_panel(
            220.0,
            Some(search_input_box(&self.sidebar_search, ControlSize::Sm)),
            vec![
                sidebar_group_label("fuli-ui-kit 展厅"),
                sidebar_nav_item(
                    "gn-0",
                    "品牌资产与物理动效",
                    self.section == GallerySection::BrandAndMotion,
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.section = GallerySection::BrandAndMotion;
                    cx.notify();
                }))
                .into_any_element(),
                sidebar_nav_item(
                    "gn-1",
                    "下拉、单选与多选表单",
                    self.section == GallerySection::SelectAndForms,
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.section = GallerySection::SelectAndForms;
                    cx.notify();
                }))
                .into_any_element(),
                sidebar_nav_item(
                    "gn-2",
                    "多形态弹窗与引导气泡",
                    self.section == GallerySection::OverlaysAndTours,
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.section = GallerySection::OverlaysAndTours;
                    cx.notify();
                }))
                .into_any_element(),
                sidebar_nav_item(
                    "gn-3",
                    "头像、折线与页面布局",
                    self.section == GallerySection::AvatarsAndLayouts,
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.section = GallerySection::AvatarsAndLayouts;
                    cx.notify();
                }))
                .into_any_element(),
                sidebar_nav_item(
                    "gn-4",
                    "丝滑交互组件（10 个）",
                    self.section == GallerySection::RichMotion,
                    true,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.section = GallerySection::RichMotion;
                    cx.notify();
                }))
                .into_any_element(),
            ],
            Some(
                div()
                    .p(px(4.0))
                    .rounded(layout::radius_control())
                    .bg(colors::subtle())
                    .border_1()
                    .border_color(colors::border())
                    .flex()
                    .gap(px(4.0))
                    .child(
                        segmented_tab("g-zh", "中文", self.locale == Locale::ZhCn)
                            .flex_1()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.locale = Locale::ZhCn;
                                cx.notify();
                            })),
                    )
                    .child(
                        segmented_tab("g-en", "EN", self.locale == Locale::EnUs)
                            .flex_1()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.locale = Locale::EnUs;
                                cx.notify();
                            })),
                    )
                    .into_any_element(),
            ),
        );

        let main_pane = match self.section {
            GallerySection::BrandAndMotion => self.render_brand_and_motion(cx),
            GallerySection::SelectAndForms => self.render_select_and_forms(cx),
            GallerySection::OverlaysAndTours => self.render_overlays_and_tours(cx),
            GallerySection::AvatarsAndLayouts => self.render_avatars_and_layouts(),
            GallerySection::RichMotion => self.render_rich_motion(cx),
        };

        let animated_main =
            div()
                .flex_1()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .child(apple_view_transition(
                    format!("gal-sec-{:?}", self.section),
                    main_pane.into_any_element(),
                ));

        let body = sidebar_content_layout(sidebar, "gallery-main-scroll", animated_main);

        let top_left = div()
            .flex()
            .items_center()
            .gap(px(14.0))
            .child(fuli_brand_lockup("ui-kit gallery", true))
            .child(status_badge(
                "40+ 原语 · 原生 GPUI 弹簧动效",
                BadgeTone::Gold,
            ))
            .into_any_element();

        let top_right = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(
                status_pill_button("g-pill-tour", "体验 3 步引导弹窗", true).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.tour_step = Some(0);
                        cx.notify();
                    },
                )),
            )
            .child(
                top_icon_button("g-top-toast", "zap", false).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.show_toast(
                            ToastPlacement::TopRight,
                            BadgeTone::Gold,
                            "顶部自动消失提醒（3.5s）",
                            Some("支持悬停查看与一键撤销".into()),
                            Some(3500),
                            true,
                            cx,
                        );
                    },
                )),
            )
            .into_any_element();

        let dock_icons = ["sun", "users", "layers", "network", "orbit"];
        let dock_slots: Vec<AnyElement> = dock_icons
            .iter()
            .enumerate()
            .map(|(idx, icon)| {
                spring_dock_slot(format!("gd-{idx}"), icon, self.active_dock == idx)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.active_dock = idx;
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .collect();

        let dock = spring_floating_dock("gal-dock-spring", self.active_dock, dock_slots);

        let mut root = fuli_shell(top_left, top_right, body.into_any_element(), dock);

        // Auto-dismissing Top / Bottom Toast
        if let Some(ref toast) = self.active_toast {
            let undo_btn = if toast.with_undo {
                Some(
                    ghost_button("t-undo", "撤销", ControlSize::Sm)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.active_toast = None;
                            this.show_toast(
                                ToastPlacement::BottomCenter,
                                BadgeTone::Success,
                                "已撤销刚才的操作",
                                None,
                                Some(2500),
                                false,
                                cx,
                            );
                        }))
                        .into_any_element(),
                )
            } else {
                None
            };
            let close_btn = Some(
                top_icon_button("t-close", "x", false)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.active_toast = None;
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            root = root.child(floating_toast_overlay(
                format!("gal-toast-{}", toast.seq),
                toast.placement,
                toast.tone,
                toast.title.clone(),
                toast.detail.clone().map(SharedString::from),
                toast.duration,
                undo_btn,
                close_btn,
            ));
        }

        // Guided 3-step Tour Popover
        if let Some(step) = self.tour_step {
            let (anchor, badge, title, desc) = match step {
                0 => (
                    TourAnchor::TopLeft,
                    "第 1 步 · 品牌与定位",
                    "左上角永远是真实的 FULI 品牌标识",
                    "包含官方黑金 Logo、几何矢量字标和后台在线绿点，不再丢掉任何品牌细节。",
                ),
                1 => (
                    TourAnchor::BottomLeftAboveDock,
                    "第 2 步 · 弹簧悬浮导航",
                    "左下角 5 图标胶囊支持物理弹簧滑行",
                    "点击任意图标，金色小圆点和高亮底托会顺着物理弹簧丝滑滑过去，绝不遮挡右侧滚动内容。",
                ),
                _ => (
                    TourAnchor::TopRight,
                    "第 3 步 · 随时自动消失的轻量提醒",
                    "重要拍板在右上角，轻提醒会自己消失",
                    "顶部与底部提醒都带平滑弹簧入场与倒计时条，不打断你的专注节奏。",
                ),
            };

            let mut ctrls = div().flex().items_center().gap(px(6.0));
            if step > 0 {
                ctrls = ctrls.child(
                    ghost_button("tour-prev", "上一步", ControlSize::Sm).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.tour_step = this.tour_step.map(|s| s.saturating_sub(1));
                            cx.notify();
                        },
                    )),
                );
            } else {
                ctrls = ctrls.child(ghost_button("tour-skip", "跳过", ControlSize::Sm).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.tour_step = None;
                        cx.notify();
                    }),
                ));
            }
            if step < 2 {
                ctrls = ctrls.child(
                    primary_button("tour-next", "下一步", ControlSize::Sm).on_click(cx.listener(
                        move |this, _, _, cx| {
                            this.tour_step = Some(step + 1);
                            cx.notify();
                        },
                    )),
                );
            } else {
                ctrls = ctrls.child(
                    primary_button("tour-done", "知道了", ControlSize::Sm).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.tour_step = None;
                            cx.notify();
                        },
                    )),
                );
            }

            root = root.child(guided_tour_popover(
                format!("gal-tour-step-{step}"),
                anchor,
                step,
                3,
                badge,
                title,
                desc,
                ctrls.into_any_element(),
            ));
        }

        // Alert Confirmation Dialog
        if self.show_alert {
            root = root.child(alert_dialog(
                "gal-alert",
                BadgeTone::Warning,
                "确认断开跨项目关联吗？",
                "断开后，对方项目下一次检索将不再看到这个知识库里的内容（已有历史记录不受影响）。",
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        secondary_button("gal-al-no", "先保留", ControlSize::Md).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.show_alert = false;
                                cx.notify();
                            }),
                        ),
                    )
                    .child(
                        danger_button("gal-al-yes", "确认断开", ControlSize::Md).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.show_alert = false;
                                this.show_toast(
                                    ToastPlacement::TopCenter,
                                    BadgeTone::Success,
                                    "已安全断开跨项目关联",
                                    None,
                                    Some(3000),
                                    true,
                                    cx,
                                );
                            }),
                        ),
                    )
                    .into_any_element(),
            ));
        }

        // Right Spring Drawer
        if self.show_drawer {
            root = root.child(detail_drawer(
                "版本演化抽屉（弹簧滑入）",
                "旧版本永久留痕，绝不覆盖丢失",
                secondary_button("g-close-drawer", l.t(CopyKey::CloseBtn), ControlSize::Sm)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_drawer = false;
                        cx.notify();
                    }))
                    .into_any_element(),
                div()
                    .flex()
                    .flex_col()
                    .gap(px(10.0))
                    .child(notice_banner(
                        BadgeTone::Success,
                        "v2 · 当前生效",
                        "先跑 cargo test --workspace，再确认 Windows + macOS CI 全绿。",
                    ))
                    .child(notice_banner(
                        BadgeTone::Neutral,
                        "v1 · 历史快照",
                        "先跑单测再打 tag。",
                    ))
                    .into_any_element(),
            ));
        }

        // Centered Form Modal
        if self.show_modal {
            root = root.child(modal_overlay(
                "居中轻弹窗示例（弹簧轻弹入场）",
                "用于新建项目、记录知识或定下红线规矩",
                div()
                    .text_size(typography::body_size())
                    .text_color(colors::muted())
                    .child("弹窗使用 20px 圆角与柔和遮罩，入场走 GPUI 原生弹簧动效，确认/取消按钮严格对齐 ControlSize::Md。")
                    .into_any_element(),
                div()
                    .flex()
                    .gap(px(8.0))
                    .child(
                        secondary_button("g-m-cancel", l.t(CopyKey::CancelBtn), ControlSize::Md)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_modal = false;
                                cx.notify();
                            })),
                    )
                    .child(
                        primary_button("g-m-ok", l.t(CopyKey::SaveBtn), ControlSize::Md).on_click(
                            cx.listener(|this, _, _, cx| {
                                this.show_modal = false;
                                this.show_toast(
                                    ToastPlacement::TopCenter,
                                    BadgeTone::Success,
                                    "表单已保存",
                                    None,
                                    Some(3000),
                                    false,
                                    cx,
                                );
                            }),
                        ),
                    )
                    .into_any_element(),
            ));
        }

        root = root.child(self.render_rich_dialogs(cx));

        root
    }
}

fn main() {
    gpui_kit::application().with_assets(FuliAssets).run(|cx| {
        gpui_kit::init(cx);
        apply_fuli_theme(cx);

        let bounds = Bounds::centered(None, size(px(1200.0), px(820.0)), cx);
        let options = fuli_window_options(bounds, size(px(920.0), px(620.0)));
        gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| GalleryView::new(window, cx))
        })
        .expect("failed to open gallery window");
    });
}
