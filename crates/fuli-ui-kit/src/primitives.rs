use gpui_kit::{
    component::{
        input::{Input, InputState},
        scroll::{Scrollable, ScrollableElement as _},
        switch::Switch,
    },
    *,
};

use crate::tokens::{ControlSize, colors, layout, typography};

// ============================================================================
// Surfaces, Layout Containers & Overlays
// ============================================================================

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

/// Subtle inset container (used for grouped list items, previews, code blocks).
pub fn inset_panel() -> Div {
    div()
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_control())
        .p(px(12.0))
        .flex()
        .flex_col()
        .gap(px(6.0))
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

/// Subtle 1px horizontal divider matching the hairline border token.
pub fn divider() -> Div {
    div().w_full().h(px(1.0)).bg(colors::border())
}

/// Smooth vertical scrollable pane with native-style auto-hiding scrollbar.
/// Wraps a `Stateful<Div>` (`flex_1`, `min_h_0`) so flex columns never clip overflow.
pub fn scroll_area(id: impl Into<ElementId>, content: Div) -> Scrollable<Stateful<Div>> {
    div()
        .id(id.into())
        .flex_1()
        .min_h(px(0.0))
        .child(content)
        .overflow_y_scrollbar()
}

/// Right-anchored detail drawer overlay (e.g. Knowledge Item version history).
pub fn detail_drawer(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    close_btn: AnyElement,
    body: AnyElement,
) -> Div {
    div()
        .absolute()
        .inset_0()
        .bg(colors::backdrop())
        .flex()
        .justify_end()
        .child(
            div()
                .w(px(460.0))
                .h_full()
                .bg(colors::surface())
                .border_l_1()
                .border_color(colors::border())
                .p(px(22.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .shadow(vec![BoxShadow {
                    inset: false,
                    color: hsla(0.0, 0.0, 0.09, 0.14),
                    offset: point(px(-6.0), px(0.0)),
                    blur_radius: px(28.0),
                    spread_radius: px(0.0),
                }])
                .child(
                    div()
                        .flex()
                        .items_start()
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
                                        .text_size(typography::section_size())
                                        .font_weight(typography::WEIGHT_STRONG)
                                        .text_color(colors::ink())
                                        .child(title.into()),
                                )
                                .child(
                                    div()
                                        .text_size(typography::meta_size())
                                        .text_color(colors::muted())
                                        .child(subtitle.into()),
                                ),
                        )
                        .child(close_btn),
                )
                .child(divider())
                .child(div().flex_1().min_h(px(0.0)).flex().flex_col().child(body)),
        )
}

/// Centered minimalist modal dialog (for creating FULI Agents, Knowledge items, or Rules).
pub fn modal_overlay(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    body: AnyElement,
    footer: AnyElement,
) -> Div {
    div()
        .absolute()
        .inset_0()
        .bg(colors::backdrop())
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(
            div()
                .w(px(520.0))
                .bg(colors::surface())
                .border_1()
                .border_color(colors::border())
                .rounded(layout::radius_dialog())
                .p(px(22.0))
                .flex()
                .flex_col()
                .gap(px(14.0))
                .shadow(vec![BoxShadow {
                    inset: false,
                    color: hsla(0.0, 0.0, 0.09, 0.16),
                    offset: point(px(0.0), px(12.0)),
                    blur_radius: px(32.0),
                    spread_radius: px(0.0),
                }])
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(3.0))
                        .child(
                            div()
                                .text_size(typography::section_size())
                                .font_weight(typography::WEIGHT_STRONG)
                                .text_color(colors::ink())
                                .child(title.into()),
                        )
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(subtitle.into()),
                        ),
                )
                .child(divider())
                .child(body)
                .child(
                    div()
                        .pt(px(6.0))
                        .flex()
                        .items_center()
                        .justify_end()
                        .gap(px(8.0))
                        .child(footer),
                ),
        )
}

// ============================================================================
// Controls (Strict 30 / 36 / 44px ControlSize Scale + Native IME Input)
// ============================================================================

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

/// Borderless quiet button for low-emphasis toolbar or inline actions.
pub fn ghost_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .rounded(layout::radius_control())
        .text_color(colors::muted())
        .text_size(size.font_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
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

/// Copy-to-clipboard button that switches to a crisp success tone when recently copied.
pub fn copy_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    copied_label: impl Into<SharedString>,
    copied: bool,
    size: ControlSize,
) -> Stateful<Div> {
    if copied {
        div()
            .id(id.into())
            .h(size.height())
            .px(size.padding_x())
            .rounded(layout::radius_control())
            .bg(colors::success_bg())
            .border_1()
            .border_color(rgb(0xa7f3d0))
            .text_color(colors::success())
            .text_size(size.font_size())
            .font_weight(typography::WEIGHT_MEDIUM)
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .child(copied_label.into())
    } else {
        secondary_button(id, label, size)
    }
}

/// Native CN/EN IME text input styled with FULI's `ControlSize` height & hairline borders.
pub fn text_input(state: &Entity<InputState>, size: ControlSize) -> Input {
    Input::new(state)
        .h(size.height())
        .bordered(true)
        .focus_bordered(true)
        .cleanable(true)
}

/// Composed search bar pairing `text_input` + primary submit button + optional right slot.
pub fn search_bar(
    state: &Entity<InputState>,
    submit_btn: AnyElement,
    extra: Option<AnyElement>,
) -> Div {
    let mut row = div()
        .w_full()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(div().flex_1().child(text_input(state, ControlSize::Md)))
        .child(submit_btn);
    if let Some(el) = extra {
        row = row.child(el);
    }
    row
}

/// Label + optional helper hint + form control stack.
pub fn form_field(
    label: impl Into<SharedString>,
    hint: Option<SharedString>,
    control: AnyElement,
) -> Div {
    let mut col = div().flex().flex_col().gap(px(5.0)).child(
        div()
            .text_size(typography::control_size())
            .font_weight(typography::WEIGHT_MEDIUM)
            .text_color(colors::ink())
            .child(label.into()),
    );
    col = col.child(control);
    if let Some(h) = hint {
        col = col.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(h),
        );
    }
    col
}

/// Accessible toggle switch styled with FULI ink/gold accents.
pub fn toggle_switch(
    id: impl Into<ElementId>,
    checked: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> Switch {
    Switch::new(id)
        .checked(checked)
        .color(Hsla::from(colors::ink()))
        .on_click(on_change)
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

// ============================================================================
// Data Display, Charts, Badges & Feedback
// ============================================================================

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

/// Compact outlined tag chip (for aliases, branches, client labels).
pub fn tag_chip(label: impl Into<SharedString>) -> Div {
    div()
        .bg(colors::surface())
        .border_1()
        .border_color(colors::border())
        .rounded(px(6.0))
        .px(px(7.0))
        .py(px(2.0))
        .text_size(typography::meta_size())
        .text_color(colors::muted())
        .child(label.into())
}

/// Keyboard shortcut keycap chip (`Enter`, `Esc`, `Ctrl+K`).
pub fn kbd_chip(key_label: impl Into<SharedString>) -> Div {
    div()
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::control_border())
        .rounded(px(5.0))
        .px(px(6.0))
        .py(px(1.0))
        .text_size(px(11.0))
        .font_weight(typography::WEIGHT_MEDIUM)
        .text_color(colors::ink())
        .child(key_label.into())
}

/// Horizontal progress / budget bar (`ratio` clamped to `0.0..=1.0`).
pub fn progress_bar(ratio: f32, tone: BadgeTone) -> Div {
    let clamped = ratio.clamp(0.0, 1.0);
    let fill = match tone {
        BadgeTone::Success => colors::success(),
        BadgeTone::Gold => colors::gold(),
        BadgeTone::Warning => colors::warning(),
        BadgeTone::Danger => colors::danger(),
        BadgeTone::Neutral => colors::ink(),
    };
    div()
        .w_full()
        .h(px(8.0))
        .rounded(layout::radius_pill())
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .overflow_hidden()
        .child(
            div()
                .h_full()
                .w(relative(clamped))
                .rounded(layout::radius_pill())
                .bg(fill),
        )
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

/// Lightweight floating toast pill for immediate confirmation feedback.
pub fn toast_pill(message: impl Into<SharedString>, tone: BadgeTone) -> Div {
    let (bg, border, fg) = match tone {
        BadgeTone::Danger => (
            colors::danger_bg(),
            colors::danger_border(),
            colors::danger(),
        ),
        BadgeTone::Success => (colors::success_bg(), rgb(0xa7f3d0), colors::success()),
        _ => (colors::surface(), colors::border(), colors::ink()),
    };
    div()
        .bg(bg)
        .border_1()
        .border_color(border)
        .rounded(layout::radius_pill())
        .px(px(16.0))
        .py(px(8.0))
        .text_size(typography::control_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .text_color(fg)
        .shadow(vec![BoxShadow {
            inset: false,
            color: hsla(0.0, 0.0, 0.09, 0.10),
            offset: point(px(0.0), px(4.0)),
            blur_radius: px(14.0),
            spread_radius: px(0.0),
        }])
        .child(message.into())
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

/// Minimalist loading placeholder bar.
pub fn skeleton_line(width: DefiniteLength, height: Pixels) -> Div {
    div()
        .w(width)
        .h(height)
        .rounded(px(6.0))
        .bg(colors::hover())
}

/// Minimalist loading placeholder card.
pub fn skeleton_card() -> Div {
    section_card()
        .child(skeleton_line(relative(0.45), px(16.0)))
        .child(skeleton_line(relative(0.85), px(12.0)))
        .child(skeleton_line(relative(0.65), px(12.0)))
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

/// Minimalist three-dot/arc compounding brand loading indicator with honest plain-language label.
pub fn growth_loading(label: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .px(px(14.0))
        .py(px(10.0))
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_control())
        .child(
            div()
                .flex()
                .items_end()
                .gap(px(3.0))
                .child(
                    div()
                        .w(px(4.0))
                        .h(px(7.0))
                        .rounded(px(2.0))
                        .bg(rgba(0xa8824a55)),
                )
                .child(
                    div()
                        .w(px(4.0))
                        .h(px(12.0))
                        .rounded(px(2.0))
                        .bg(rgba(0xa8824aa8)),
                )
                .child(
                    div()
                        .w(px(4.0))
                        .h(px(17.0))
                        .rounded(px(2.0))
                        .bg(colors::gold()),
                ),
        )
        .child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(label.into()),
        )
}

/// Reusable FULI application shell: top brand/page bar + canvas slot + bottom floating capsule dock.
pub fn fuli_shell(
    brand: impl Into<SharedString>,
    connected: bool,
    page_heading: impl Into<SharedString>,
    top_right: AnyElement,
    main_content: AnyElement,
    dock_content: AnyElement,
) -> Div {
    div()
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
                        .gap(px(12.0))
                        .child(
                            div()
                                .text_size(typography::card_title_size())
                                .font_weight(typography::WEIGHT_STRONG)
                                .text_color(colors::ink())
                                .child(brand.into()),
                        )
                        .child(div().size(px(8.0)).rounded(layout::radius_pill()).bg(
                            if connected {
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
                                .child(page_heading.into()),
                        ),
                )
                .child(top_right),
        )
        .child(
            div()
                .flex_1()
                .min_h(px(0.0))
                .px(px(24.0))
                .pt(px(18.0))
                .pb(px(84.0))
                .flex()
                .child(main_content),
        )
        .child(
            div()
                .absolute()
                .bottom(px(18.0))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(dock_content),
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
