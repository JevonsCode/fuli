//! Interactive Storybook / Gallery for `fuli-ui-kit`.
//! Run with: `cargo run -p fuli-ui-kit --example gallery`

use fuli_ui_kit::{InputEvent, colors, *};
use gpui_kit::*;

struct GalleryView {
    locale: Locale,
    search_input: Entity<InputState>,
    note_input: Entity<InputState>,
    search_result: String,
    switch_on: bool,
    copied: bool,
    selected_row: usize,
    active_dock: usize,
    show_drawer: bool,
    show_modal: bool,
    toast: Option<String>,
    _subscriptions: Vec<Subscription>,
}

impl GalleryView {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("试试输入中文或英文关键词，回车触发搜索...")
        });
        let note_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("支持原生中文输入法 (IME) 与复制粘贴...")
                .default_value("所有列表卡片禁止装饰性阴影")
        });

        let sub = cx.subscribe_in(
            &search_input,
            window,
            |this, state, ev: &InputEvent, _, cx| {
                if matches!(ev, InputEvent::PressEnter { .. }) {
                    let q = state.read(cx).value().to_string();
                    this.search_result = if q.trim().is_empty() {
                        "请输入关键词".into()
                    } else {
                        format!("实时搜索已触发：「{q}」")
                    };
                    cx.notify();
                }
            },
        );

        Self {
            locale: Locale::ZhCn,
            search_input,
            note_input,
            search_result: "等待输入查询".into(),
            switch_on: true,
            copied: false,
            selected_row: 0,
            active_dock: 0,
            show_drawer: false,
            show_modal: false,
            toast: None,
            _subscriptions: vec![sub],
        }
    }
}

impl Render for GalleryView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let l = self.locale;

        let body = div()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .pb(px(90.0))
            // 1. Buttons & ControlSize 30/36/44
            .child(
                section_card()
                    .child(section_header(
                        "按钮与三档统一尺度（30 / 36 / 44px）",
                        Some(status_badge("严格等高对齐", BadgeTone::Gold).into_any_element()),
                    ))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.0))
                            .child(primary_button("g-p-sm", "主按钮 Sm (30)", ControlSize::Sm))
                            .child(primary_button("g-p-md", "主按钮 Md (36)", ControlSize::Md))
                            .child(primary_button("g-p-lg", "主按钮 Lg (44)", ControlSize::Lg))
                            .child(secondary_button("g-s-md", "次按钮 Md", ControlSize::Md))
                            .child(ghost_button("g-g-md", "静默按钮", ControlSize::Md))
                            .child(danger_button("g-d-md", "危险操作", ControlSize::Md))
                            .child(
                                copy_button(
                                    "g-copy",
                                    "复制命令",
                                    "已复制到剪贴板",
                                    self.copied,
                                    ControlSize::Md,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(
                                            "cargo run -p fuli-ui-kit --example gallery".into(),
                                        ));
                                        this.copied = true;
                                        this.toast = Some("示例命令已写入系统剪贴板".into());
                                        cx.notify();
                                    },
                                )),
                            ),
                    ),
            )
            // 2. Native IME Inputs, SearchBar & Switch
            .child(
                section_card()
                    .child(section_header(
                        "原生中英 IME 输入框、搜索栏与开关",
                        Some(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.0))
                                .child(kbd_chip("Enter"))
                                .child(kbd_chip("Ctrl+V"))
                                .into_any_element(),
                        ),
                    ))
                    .child(search_bar(
                        &self.search_input,
                        primary_button("g-search-btn", l.t(CopyKey::SearchBtn), ControlSize::Md)
                            .on_click(cx.listener(|this, _, _, cx| {
                                let q = this.search_input.read(cx).value().to_string();
                                this.search_result = format!("点击搜索：「{q}」");
                                cx.notify();
                            }))
                            .into_any_element(),
                        Some(
                            status_badge(self.search_result.clone(), BadgeTone::Neutral)
                                .into_any_element(),
                        ),
                    ))
                    .child(form_field(
                        "规矩正文输入（测试中文输入法）",
                        Some("与 GPUI 原生焦点环和光标色板完全一致".into()),
                        text_input(&self.note_input, ControlSize::Md).into_any_element(),
                    ))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.0))
                                    .child(toggle_switch(
                                        "g-switch",
                                        self.switch_on,
                                        cx.listener(|this, checked: &bool, _, cx| {
                                            this.switch_on = *checked;
                                            cx.notify();
                                        }),
                                    ))
                                    .child(div().text_size(typography::body_size()).child(
                                        if self.switch_on {
                                            "跨知识库 1–2 跳授权引用：已开启"
                                        } else {
                                            "跨知识库 1–2 跳授权引用：已关闭"
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(8.0))
                                    .child(
                                        secondary_button(
                                            "g-open-drawer",
                                            "打开右侧抽屉",
                                            ControlSize::Sm,
                                        )
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.show_drawer = true;
                                                cx.notify();
                                            }),
                                        ),
                                    )
                                    .child(
                                        secondary_button(
                                            "g-open-modal",
                                            "打开轻弹窗",
                                            ControlSize::Sm,
                                        )
                                        .on_click(
                                            cx.listener(|this, _, _, cx| {
                                                this.show_modal = true;
                                                cx.notify();
                                            }),
                                        ),
                                    ),
                            ),
                    ),
            )
            // 3. Data Cards, Sparkline, Progress, Tags & Conflict Split
            .child(
                div()
                    .flex()
                    .gap(px(16.0))
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("数据磁贴、7 周复利趋势与进度条", None))
                            .child(
                                div()
                                    .flex()
                                    .gap(px(10.0))
                                    .child(stat_tile("10.03 MiB", "常驻后台", "目标 < 25 MiB"))
                                    .child(stat_tile("7.55 ms", "冷启 Hook", "p95 8.66 ms")),
                            )
                            .child(sparkline_bars(&[2, 5, 4, 9, 12, 15, 21]))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.0))
                                    .child(
                                        div()
                                            .text_size(typography::meta_size())
                                            .text_color(colors::muted())
                                            .child("后台内存水位（10.03 / 25.00 MiB）"),
                                    )
                                    .child(progress_bar(0.40, BadgeTone::Success)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_wrap()
                                    .gap(px(6.0))
                                    .child(status_badge("已生效", BadgeTone::Success))
                                    .child(status_badge("待确认", BadgeTone::Warning))
                                    .child(status_badge("红线冲突", BadgeTone::Danger))
                                    .child(status_badge("复利 +3", BadgeTone::Gold))
                                    .child(tag_chip("branch: next"))
                                    .child(tag_chip("claude-code")),
                            ),
                    )
                    .child(
                        section_card()
                            .flex_1()
                            .child(section_header("列表行、冲突二选一卡与骨架屏", None))
                            .child(
                                inset_list_row(
                                    "g-row-0",
                                    "FULI Core",
                                    "2 个绑定路径 · 可查阅 3 个知识库",
                                    self.selected_row == 0,
                                    Some(status_badge("选中", BadgeTone::Gold).into_any_element()),
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.selected_row = 0;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                inset_list_row(
                                    "g-row-1",
                                    "潮池账本",
                                    "1 个绑定路径 · 2 条进行中工作线",
                                    self.selected_row == 1,
                                    None,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.selected_row = 1;
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(conflict_split_card(
                                "规矩打架了：code.comments",
                                "两条红线规矩互相矛盾，需要你二选一。",
                                inset_panel()
                                    .flex_1()
                                    .child("全部使用中文注释")
                                    .child(primary_button("g-c-l", "留这条", ControlSize::Sm))
                                    .into_any_element(),
                                inset_panel()
                                    .flex_1()
                                    .child("公开仓库统一英文注释")
                                    .child(primary_button("g-c-r", "留这条", ControlSize::Sm))
                                    .into_any_element(),
                            ))
                            .child(skeleton_card()),
                    ),
            );

        let mut root = div()
            .size_full()
            .bg(colors::canvas())
            .text_color(colors::ink())
            .flex()
            .flex_col()
            .relative()
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
                            .gap(px(10.0))
                            .child(
                                div()
                                    .text_size(typography::title_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .child("fuli-ui-kit · 组件库画廊"),
                            )
                            .child(status_badge("22 个复用原语", BadgeTone::Gold)),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(6.0))
                            .child(
                                segmented_tab("g-zh", "中文", self.locale == Locale::ZhCn)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.locale = Locale::ZhCn;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                segmented_tab("g-en", "EN", self.locale == Locale::EnUs).on_click(
                                    cx.listener(|this, _, _, cx| {
                                        this.locale = Locale::EnUs;
                                        cx.notify();
                                    }),
                                ),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.0))
                    .px(px(24.0))
                    .pt(px(18.0))
                    .flex()
                    .flex_col()
                    .child(scroll_area("gallery-scroll", body)),
            )
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
                                dock_item("gd-0", l.t(CopyKey::NavToday), self.active_dock == 0)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.active_dock = 0;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                dock_item("gd-1", l.t(CopyKey::NavAgents), self.active_dock == 1)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.active_dock = 1;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                dock_item("gd-2", l.t(CopyKey::NavMemory), self.active_dock == 2)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.active_dock = 2;
                                        cx.notify();
                                    })),
                            ),
                    ),
            );

        if let Some(ref msg) = self.toast {
            root = root.child(
                div()
                    .absolute()
                    .top(px(68.0))
                    .right(px(24.0))
                    .child(toast_pill(msg.clone(), BadgeTone::Success)),
            );
        }

        if self.show_drawer {
            root = root.child(detail_drawer(
                "版本演化抽屉示例",
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

        if self.show_modal {
            root = root.child(modal_overlay(
                "居中轻弹窗示例",
                "用于新建 FULI Agent、记录知识或定下红线规矩",
                div()
                    .text_size(typography::body_size())
                    .text_color(colors::muted())
                    .child(
                        "弹窗统一使用 20px 圆角与柔和遮罩，确认/取消按钮严格走 ControlSize::Md。",
                    )
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
                                this.toast = Some("弹窗保存回调已触发".into());
                                cx.notify();
                            }),
                        ),
                    )
                    .into_any_element(),
            ));
        }

        root
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        apply_fuli_theme(cx);

        let bounds = Bounds::centered(None, size(px(1160.0), px(780.0)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("FULI UI Kit · Gallery".into()),
                appears_transparent: false,
                traffic_light_position: None,
            }),
            ..WindowOptions::default()
        };
        gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| GalleryView::new(window, cx))
        })
        .expect("failed to open gallery window");
    });
}
