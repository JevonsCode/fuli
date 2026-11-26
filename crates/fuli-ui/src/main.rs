mod memory;

use std::time::{Duration, Instant};

use fuli_ipc::{IpcRequest, IpcResponse, MemorySnapshot, resolve_ipc_name, send_request};
use fuli_ui_kit::{
    BadgeTone, ControlSize, colors, dock_item, floating_dock, layout, primary_button,
    secondary_button, section_card, stat_tile, status_badge, typography,
};
use gpui_kit::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavTab {
    Today,
    Units,
    Memory,
    Inspector,
}

impl NavTab {
    fn heading(self) -> &'static str {
        match self {
            Self::Today => "今天",
            Self::Units => "工作台单元",
            Self::Memory => "记忆与偏好",
            Self::Inspector => "交付透视镜",
        }
    }
}

struct DaemonStatusView {
    connected: bool,
    daemon_pid: Option<u32>,
    daemon_mem: MemorySnapshot,
    ui_mem: MemorySnapshot,
    ipc_rtt_ms: f64,
    uptime_secs: u64,
    note: String,
}

impl DaemonStatusView {
    fn fetch(endpoint: &str) -> Self {
        let ui_mem = memory::current_process_memory();
        let t0 = Instant::now();
        match send_request(endpoint, &IpcRequest::Ping) {
            Ok(IpcResponse::Pong {
                pid,
                memory,
                uptime_secs,
                ..
            }) => Self {
                connected: true,
                daemon_pid: Some(pid),
                daemon_mem: memory,
                ui_mem,
                ipc_rtt_ms: t0.elapsed().as_secs_f64() * 1000.0,
                uptime_secs,
                note: "fuli-context 已通过本地 IPC 连接".to_string(),
            },
            Ok(_) => Self {
                connected: false,
                daemon_pid: None,
                daemon_mem: MemorySnapshot {
                    working_set_bytes: 0,
                    private_bytes: 0,
                },
                ui_mem,
                ipc_rtt_ms: 0.0,
                uptime_secs: 0,
                note: "收到意外的后台应答".to_string(),
            },
            Err(err) => Self {
                connected: false,
                daemon_pid: None,
                daemon_mem: MemorySnapshot {
                    working_set_bytes: 0,
                    private_bytes: 0,
                },
                ui_mem,
                ipc_rtt_ms: 0.0,
                uptime_secs: 0,
                note: format!("后台未运行 ({err})"),
            },
        }
    }
}

struct FuliAppView {
    endpoint: String,
    close_grace_secs: u64,
    tab: NavTab,
    status: DaemonStatusView,
}

impl FuliAppView {
    fn new(endpoint: String, close_grace_secs: u64) -> Self {
        let status = DaemonStatusView::fetch(&endpoint);
        Self {
            endpoint,
            close_grace_secs,
            tab: NavTab::Today,
            status,
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        self.status = DaemonStatusView::fetch(&self.endpoint);
        cx.notify();
    }

    fn switch_tab(&mut self, tab: NavTab, cx: &mut Context<Self>) {
        self.tab = tab;
        cx.notify();
    }

    fn render_today(&self, cx: &mut Context<Self>) -> Div {
        let daemon_mib = if self.status.connected {
            format!("{:.1} MiB", self.status.daemon_mem.working_set_mib())
        } else {
            "未连接".to_string()
        };
        let ui_mib = format!("{:.1} MiB", self.status.ui_mem.working_set_mib());
        let ipc_label = if self.status.connected {
            format!("{:.2} ms", self.status.ipc_rtt_ms)
        } else {
            "—".to_string()
        };
        let grace_label = if self.close_grace_secs == 0 {
            "立即退出".to_string()
        } else {
            format!("{}s 后退出", self.close_grace_secs)
        };

        div()
            .flex_1()
            .flex()
            .gap(px(18.0))
            // Left half: Compounding statement stage (classic FULI home layout)
            .child(
                section_card()
                    .flex_1()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_size(typography::section_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .child("这周的复利账单"),
                            )
                            .child(status_badge("M0 内存基线", BadgeTone::Gold)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.0))
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
                                            .child("0"),
                                    )
                                    .child(
                                        div()
                                            .text_size(typography::body_size())
                                            .text_color(colors::muted())
                                            .child("让每一次协作，都产生复利"),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child("M1 接通单一 SQLite 记忆核后，这里将只展示真实复利生效记录。"),
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
                                        daemon_mib,
                                        "fuli-context 后台常驻",
                                        "无 GPU · 目标 < 25 MiB",
                                    ))
                                    .child(stat_tile(
                                        ui_mib,
                                        "fuli-ui 当前窗口",
                                        "关闭窗口后内存归零",
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(10.0))
                                    .child(stat_tile(
                                        ipc_label,
                                        "本地 IPC 往返",
                                        "Named Pipe / UDS",
                                    ))
                                    .child(stat_tile(
                                        grace_label,
                                        "关窗回收策略",
                                        "彻底 exit(0) 释放 GPU",
                                    )),
                            ),
                    ),
            )
            // Right half: Live M0 control & verification column
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(16.0))
                    .child(
                        section_card()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_size(typography::section_size())
                                            .font_weight(typography::WEIGHT_STRONG)
                                            .child("进程隔离状态"),
                                    )
                                    .child(if self.status.connected {
                                        status_badge("后台在线", BadgeTone::Success)
                                    } else {
                                        status_badge("后台离线", BadgeTone::Warning)
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(typography::body_size())
                                    .text_color(colors::muted())
                                    .child(format!(
                                        "{} · 进程 PID: {} · 已运行 {}s",
                                        self.status.note,
                                        self.status
                                            .daemon_pid
                                            .map(|p| p.to_string())
                                            .unwrap_or_else(|| "—".into()),
                                        self.status.uptime_secs
                                    )),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.0))
                                    .child(
                                        primary_button(
                                            "btn-refresh",
                                            "刷新实时内存",
                                            ControlSize::Md,
                                        )
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.refresh(cx);
                                        })),
                                    )
                                    .child(
                                        secondary_button(
                                            "btn-close-now",
                                            "关闭窗口并立即释放内存",
                                            ControlSize::Md,
                                        )
                                        .on_click(cx.listener(
                                            |this, _, _window, cx| {
                                                let _ = send_request(
                                                    &this.endpoint,
                                                    &IpcRequest::NotifyUiClosing { grace_secs: 0 },
                                                );
                                                cx.quit();
                                            },
                                        )),
                                    ),
                            ),
                    )
                    .child(
                        section_card()
                            .child(
                                div()
                                    .text_size(typography::section_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .child("即将接入的内核里程碑"),
                            )
                            .child(
                                div()
                                    .text_size(typography::body_size())
                                    .text_color(colors::muted())
                                    .child("• M1：单一 SQLite WAL + 9 个核心 MCP 工具 + Claude Code / Codex 毫秒级 Hook\n• M2：零越权双语混合检索 (FTS5 + 按需卸载向量) + v1 数据一次性 JSON 导入\n• M3：统一多客户端工作台 (Workbench / Workflow) + 轻量圆桌按 Session ID 唤起"),
                            ),
                    ),
            )
    }

    fn render_placeholder(&self, title: &'static str, detail: &'static str) -> Div {
        div().flex_1().child(
            section_card()
                .child(
                    div()
                        .text_size(typography::section_size())
                        .font_weight(typography::WEIGHT_STRONG)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(typography::body_size())
                        .text_color(colors::muted())
                        .child(detail),
                ),
        )
    }
}

impl Render for FuliAppView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mem_badge = if self.status.connected {
            format!(
                "后台 {:.1} MiB · 窗口 {:.1} MiB",
                self.status.daemon_mem.working_set_mib(),
                self.status.ui_mem.working_set_mib()
            )
        } else {
            format!("窗口 {:.1} MiB", self.status.ui_mem.working_set_mib())
        };

        let content = match self.tab {
            NavTab::Today => self.render_today(cx),
            NavTab::Units => self.render_placeholder(
                "统一多客户端工作台（M3）",
                "在这里集中管理每个项目体底下的多仓库、各客户端活跃会话、Workbench 看板与自增长 Workflow。",
            ),
            NavTab::Memory => self.render_placeholder(
                "知识库 · 个人与项目偏好（M1/M2）",
                "左侧管理知识库与 1–2 跳授权引用，右侧中英混合搜索、版本演化史与红线规则冲突拍板。",
            ),
            NavTab::Inspector => self.render_placeholder(
                "交付透视镜（M1）",
                "逐轮展示每条规则、偏好与知识是否完整注入或去重跳过，告别上下文黑盒。",
            ),
        };

        div()
            .size_full()
            .bg(colors::canvas())
            .text_color(colors::ink())
            .flex()
            .flex_col()
            .relative()
            // Top bar: Brand + Service dot + Page H1 + Live memory readout
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
                                    .child("FULI 复利"),
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
                                    .child(self.tab.heading()),
                            ),
                    )
                    .child(status_badge(mem_badge, BadgeTone::Neutral)),
            )
            // Main workspace canvas
            .child(
                div()
                    .flex_1()
                    .px(px(24.0))
                    .pt(px(20.0))
                    .pb(px(84.0))
                    .flex()
                    .child(content),
            )
            // Bottom floating capsule dock
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
                                dock_item("dock-today", "工作台", self.tab == NavTab::Today)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Today, cx);
                                    })),
                            )
                            .child(
                                dock_item("dock-units", "单元", self.tab == NavTab::Units)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Units, cx);
                                    })),
                            )
                            .child(
                                dock_item("dock-memory", "记忆", self.tab == NavTab::Memory)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.switch_tab(NavTab::Memory, cx);
                                    })),
                            )
                            .child(
                                dock_item(
                                    "dock-inspector",
                                    "透视镜",
                                    self.tab == NavTab::Inspector,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.switch_tab(NavTab::Inspector, cx);
                                    },
                                )),
                            ),
                    ),
            )
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

        let bounds = Bounds::centered(None, size(px(1120.0), px(740.0)), cx);
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
