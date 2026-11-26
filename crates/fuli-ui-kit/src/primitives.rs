use gpui_kit::*;

use crate::tokens::{ControlSize, colors, layout, typography};

/// Hairline-bordered pure white card with zero decorative shadow.
pub fn section_card() -> Div {
    div()
        .bg(colors::surface())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_card())
        .p(px(20.0))
        .flex()
        .flex_col()
        .gap(px(14.0))
}

/// Consistent section heading row with optional right-side badge/action slot.
pub fn section_header(title: impl Into<SharedString>, right: Option<AnyElement>) -> Div {
    let mut row = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(10.0))
        .child(
            div()
                .text_size(typography::section_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(colors::ink())
                .child(title.into()),
        );
    if let Some(el) = right {
        row = row.child(el);
    }
    row
}

/// Subtle inset metric tile (used in Today's 2×2 compounding statement grid).
pub fn stat_tile(
    value: impl Into<SharedString>,
    label: impl Into<SharedString>,
    sub: impl Into<SharedString>,
) -> Div {
    div()
        .flex_1()
        .bg(colors::subtle())
        .rounded(layout::radius_control())
        .px(px(14.0))
        .py(px(12.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .text_size(typography::title_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(colors::ink())
                .child(value.into()),
        )
        .child(
            div()
                .text_size(typography::body_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(label.into()),
        )
        .child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(sub.into()),
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadgeTone {
    Neutral,
    Success,
    Warning,
    Danger,
    Gold,
}

/// Compact pill badge for status, scope, and memory readouts.
pub fn status_badge(label: impl Into<SharedString>, tone: BadgeTone) -> Div {
    let (bg, fg) = match tone {
        BadgeTone::Neutral => (colors::subtle(), colors::muted()),
        BadgeTone::Success => (colors::success_bg(), colors::success()),
        BadgeTone::Warning => (colors::warning_bg(), colors::warning()),
        BadgeTone::Danger => (colors::danger_bg(), colors::danger()),
        BadgeTone::Gold => (colors::gold_soft(), colors::gold()),
    };
    div()
        .bg(bg)
        .text_color(fg)
        .rounded(layout::radius_pill())
        .px(px(10.0))
        .py(px(3.0))
        .text_size(typography::meta_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .child(label.into())
}

/// Primary ink button following the unified `ControlSize` height scale.
pub fn primary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .rounded(layout::radius_control())
        .bg(colors::ink())
        .text_color(colors::surface())
        .text_size(size.font_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(colors::ink_hover()))
        .child(label.into())
}

/// Secondary outlined button following the unified `ControlSize` height scale.
pub fn secondary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .rounded(layout::radius_control())
        .bg(colors::surface())
        .border_1()
        .border_color(colors::control_border())
        .text_color(colors::ink())
        .text_size(size.font_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(colors::subtle()))
        .child(label.into())
}

/// Subtle danger button used strictly for destructive / conflict dismissal choices.
pub fn danger_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .rounded(layout::radius_control())
        .bg(colors::danger_bg())
        .border_1()
        .border_color(colors::danger_border())
        .text_color(colors::danger())
        .text_size(size.font_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(rgb(0xfee4e2)))
        .child(label.into())
}

/// Segmented pill tab item (for `知识库 | 个人与项目偏好`, `中文 | EN`, autonomy modes).
pub fn segmented_tab(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    active: bool,
) -> Stateful<Div> {
    let base = div()
        .id(id.into())
        .h(ControlSize::Sm.height())
        .px(px(12.0))
        .rounded(layout::radius_control())
        .text_size(typography::control_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer();
    if active {
        base.bg(colors::ink())
            .text_color(colors::surface())
            .child(label.into())
    } else {
        base.bg(colors::subtle())
            .text_color(colors::muted())
            .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
            .child(label.into())
    }
}

/// Reusable selectable inset list row (agents, KBs, workstreams, sessions).
pub fn inset_list_row(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    selected: bool,
    trailing: Option<AnyElement>,
) -> Stateful<Div> {
    let mut row = div()
        .id(id.into())
        .px(px(14.0))
        .py(px(10.0))
        .rounded(layout::radius_control())
        .border_1()
        .border_color(if selected {
            colors::ink()
        } else {
            colors::border()
        })
        .bg(if selected {
            colors::subtle()
        } else {
            colors::surface()
        })
        .flex()
        .items_center()
        .justify_between()
        .gap(px(10.0))
        .cursor_pointer()
        .hover(|style| style.bg(colors::subtle()))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(typography::body_size())
                        .font_weight(typography::WEIGHT_MEDIUM)
                        .text_color(colors::ink())
                        .child(title.into()),
                )
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(subtitle.into()),
                ),
        );
    if let Some(el) = trailing {
        row = row.child(el);
    }
    row
}

/// 7-week gold sparkline bars — renders crisp, zero-shader, identical across Win DX12 & macOS Metal.
pub fn sparkline_bars(values: &[i64]) -> Div {
    let max_val = values.iter().copied().max().unwrap_or(1).max(1) as f32;
    let total = values.len().max(1);
    let mut container = div()
        .h(px(52.0))
        .px(px(12.0))
        .py(px(8.0))
        .bg(colors::subtle())
        .rounded(layout::radius_control())
        .flex()
        .items_end()
        .gap(px(8.0));

    for (idx, &val) in values.iter().enumerate() {
        let ratio = (val.max(0) as f32) / max_val;
        let bar_h = (6.0 + ratio * 28.0).round();
        let is_latest = idx + 1 == total;
        container = container.child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_end()
                .gap(px(4.0))
                .child(
                    div()
                        .w_full()
                        .h(px(bar_h))
                        .rounded(px(4.0))
                        .bg(if is_latest {
                            colors::gold()
                        } else {
                            rgba(0xa8824a55)
                        }),
                ),
        );
    }
    container
}

/// Notice banner for status alerts, Dreaming suggestions, or guidance.
pub fn notice_banner(
    tone: BadgeTone,
    headline: impl Into<SharedString>,
    detail: impl Into<SharedString>,
) -> Div {
    let (bg, border, fg) = match tone {
        BadgeTone::Danger => (
            colors::danger_bg(),
            colors::danger_border(),
            colors::danger(),
        ),
        BadgeTone::Warning => (colors::warning_bg(), rgb(0xfde68a), colors::warning()),
        BadgeTone::Success => (colors::success_bg(), rgb(0xa7f3d0), colors::success()),
        BadgeTone::Gold => (colors::gold_soft(), rgb(0xe5d5bd), colors::gold()),
        BadgeTone::Neutral => (colors::subtle(), colors::border(), colors::ink()),
    };
    div()
        .bg(bg)
        .border_1()
        .border_color(border)
        .rounded(layout::radius_control())
        .px(px(14.0))
        .py(px(10.0))
        .flex()
        .flex_col()
        .gap(px(3.0))
        .child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(fg)
                .child(headline.into()),
        )
        .child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::ink())
                .child(detail.into()),
        )
}

/// Red hairline conflict split card surfacing two conflicting rules side-by-side.
pub fn conflict_split_card(
    title: impl Into<SharedString>,
    reason: impl Into<SharedString>,
    left_slot: AnyElement,
    right_slot: AnyElement,
) -> Div {
    div()
        .bg(colors::danger_bg())
        .border_1()
        .border_color(colors::danger_border())
        .rounded(layout::radius_card())
        .p(px(16.0))
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_size(typography::card_title_size())
                        .font_weight(typography::WEIGHT_STRONG)
                        .text_color(colors::danger())
                        .child(title.into()),
                )
                .child(status_badge("需要你二选一", BadgeTone::Danger)),
        )
        .child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(reason.into()),
        )
        .child(
            div()
                .flex()
                .gap(px(10.0))
                .child(left_slot)
                .child(right_slot),
        )
}

/// Clean empty state panel in plain human language.
pub fn empty_state(title: impl Into<SharedString>, sub: impl Into<SharedString>) -> Div {
    div()
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_control())
        .px(px(18.0))
        .py(px(16.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .text_size(typography::body_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(title.into()),
        )
        .child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(sub.into()),
        )
}

/// Clean key-value metadata row for Settings / Inspector.
pub fn kv_row(label: impl Into<SharedString>, value: impl Into<SharedString>) -> Div {
    div()
        .py(px(6.0))
        .border_b_1()
        .border_color(colors::border())
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::muted())
                .child(label.into()),
        )
        .child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(value.into()),
        )
}

/// Crisp floating bottom capsule dock (translucent white + hairline border + subtle lift shadow).
pub fn floating_dock() -> Div {
    div()
        .bg(colors::dock_surface())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_pill())
        .px(px(8.0))
        .py(px(6.0))
        .flex()
        .items_center()
        .gap(px(4.0))
        .shadow(vec![BoxShadow {
            inset: false,
            color: hsla(0.0, 0.0, 0.09, 0.10),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(24.0),
            spread_radius: px(0.0),
        }])
}

/// Single destination item inside `floating_dock`.
pub fn dock_item(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    active: bool,
) -> Stateful<Div> {
    let base = div()
        .id(id.into())
        .h(px(32.0))
        .px(px(14.0))
        .rounded(layout::radius_pill())
        .text_size(typography::control_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer();

    if active {
        base.bg(colors::ink())
            .text_color(colors::surface())
            .child(label.into())
    } else {
        base.text_color(colors::muted())
            .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
            .child(label.into())
    }
}
