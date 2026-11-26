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

/// Subtle inset metric tile (used in the Today 2x2 compounding statement grid).
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
    Gold,
}

/// Compact pill badge for status, scope, and memory readouts.
pub fn status_badge(label: impl Into<SharedString>, tone: BadgeTone) -> Div {
    let (bg, fg) = match tone {
        BadgeTone::Neutral => (colors::subtle(), colors::muted()),
        BadgeTone::Success => (colors::success_bg(), colors::success()),
        BadgeTone::Warning => (colors::warning_bg(), colors::warning()),
        BadgeTone::Gold => (rgba(0xa8824a24), colors::gold()),
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
        .hover(|style| style.bg(rgb(0x2c2c31)))
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

/// Crisp floating bottom capsule dock (translucent white + hairline border +
/// subtle lift shadow; avoids unstable element-level GPU blur across Windows/macOS).
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
