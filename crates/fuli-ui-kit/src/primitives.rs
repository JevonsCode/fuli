use std::time::Duration;

use gpui_kit::{
    component::{
        input::{Input, InputState},
        scroll::{Scrollable, ScrollableElement as _},
        switch::Switch,
    },
    *,
};

use crate::layout_kit::FuliTitleBar;
use crate::motion::{apple_ease_out, backdrop_fade, live_pulse_dot, spring_entrance};
use crate::tokens::{ControlSize, colors, layout, typography};

// ============================================================================
// Surfaces, Layout Containers & Overlays
// ============================================================================

/// Hairline-bordered pure white card with zero decorative shadow and `min_w_0` text safety.
pub fn section_card() -> Div {
    div()
        .w_full()
        .min_w(px(0.0))
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
        .w_full()
        .min_w(px(0.0))
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
        .w_full()
        .min_w(px(0.0))
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
/// Enforces `flex_1`, `min_w_0`, `min_h_0` so flex columns wrap cleanly and never clip overflow.
pub fn scroll_area(id: impl Into<ElementId>, content: Div) -> Scrollable<Stateful<Div>> {
    div()
        .id(id.into())
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .child(content.w_full().min_w(px(0.0)))
        .overflow_y_scrollbar()
}

/// Right-anchored detail drawer overlay (e.g. Knowledge Item version history)
/// with synchronized Apple scrim fade & smooth horizontal spring slide-in.
pub fn detail_drawer(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    close_btn: AnyElement,
    body: AnyElement,
) -> AnyElement {
    let sheet = div()
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
                        .min_w(px(0.0))
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
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .child(body),
        );

    let wrapper = div()
        .absolute()
        .inset_0()
        .flex()
        .justify_end()
        .child(spring_entrance(
            "fuli-detail-drawer-spring",
            42.0,
            0.0,
            sheet.into_any_element(),
        ));

    backdrop_fade("fuli-detail-drawer-scrim", colors::backdrop(), wrapper)
}

/// Centered minimalist modal dialog (for creating FULI Agents, Knowledge items, or Rules)
/// with synchronized Apple scrim fade & smooth spring pop-in.
pub fn modal_overlay(
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    body: AnyElement,
    footer: AnyElement,
) -> AnyElement {
    let card = div()
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
        );

    let wrapper = div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.0))
        .child(spring_entrance(
            "fuli-modal-overlay-spring",
            0.0,
            16.0,
            card.into_any_element(),
        ));

    backdrop_fade("fuli-modal-overlay-scrim", colors::backdrop(), wrapper)
}

// ============================================================================
// Controls (Strict 30 / 36 / 44px ControlSize Scale + Tactile Apple Micro-Interactions)
// ============================================================================

/// Primary ink button following the unified `ControlSize` height scale with tactile press state.
pub fn primary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .flex_shrink_0()
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
        .active(|style| style.bg(rgb(0x0b0b0d)).pt(px(1.0)))
        .child(label.into())
}

/// Secondary outlined button following the unified `ControlSize` height scale with tactile press state.
pub fn secondary_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    size: ControlSize,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .h(size.height())
        .px(size.padding_x())
        .flex_shrink_0()
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
        .hover(|style| style.bg(colors::subtle()).border_color(rgb(0xc7c3b8)))
        .active(|style| style.bg(colors::hover()).pt(px(1.0)))
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
        .flex_shrink_0()
        .rounded(layout::radius_control())
        .text_color(colors::muted())
        .text_size(size.font_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
        .active(|style| style.bg(rgb(0xe6e4dd)).pt(px(1.0)))
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
        .flex_shrink_0()
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
        .active(|style| style.bg(rgb(0xfecdca)).pt(px(1.0)))
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
            .flex_shrink_0()
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
        .min_w(px(0.0))
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .child(text_input(state, ControlSize::Md)),
        )
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
    let mut col = div()
        .w_full()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(5.0))
        .child(
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
        .flex_shrink_0()
        .rounded(layout::radius_control())
        .text_size(typography::control_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, window, cx| {
            window.prevent_default();
            cx.stop_propagation();
        });
    if active {
        base.bg(colors::ink())
            .text_color(colors::surface())
            .child(label.into())
    } else {
        base.bg(colors::subtle())
            .text_color(colors::muted())
            .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
            .active(|style| style.bg(rgb(0xe4e1d8)).pt(px(1.0)))
            .child(label.into())
    }
}

// ============================================================================
// Data Display, Charts, Badges & Feedback
// ============================================================================

/// Subtle inset metric tile (used in Today's compounding statement grid) with warm hover feedback.
pub fn stat_tile(
    value: impl Into<SharedString>,
    label: impl Into<SharedString>,
    sub: impl Into<SharedString>,
) -> Div {
    div()
        .w_full()
        .min_w(px(0.0))
        .bg(colors::subtle())
        .border_1()
        .border_color(rgba(0x00000000))
        .rounded(layout::radius_control())
        .px(px(14.0))
        .py(px(12.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .hover(|s| s.bg(colors::hover()).border_color(colors::border()))
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
        .flex_shrink_0()
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
        .flex_shrink_0()
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
        .flex_shrink_0()
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

/// Reusable selectable inset list row (agents, KBs, workstreams, sessions) with tactile feedback.
pub fn inset_list_row(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    selected: bool,
    trailing: Option<AnyElement>,
) -> Stateful<Div> {
    let mut row = div()
        .id(id.into())
        .w_full()
        .min_w(px(0.0))
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
        .hover(|style| {
            style
                .bg(colors::subtle())
                .border_color(colors::control_border())
        })
        .active(|style| style.bg(colors::hover()))
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

/// Minimalist crisp polyline sparkline (matching FULI v0.27.16 visual calm) drawn via GPUI Canvas
/// with silky left-to-right Apple ease-out draw-in reveal & blooming gold endpoint dot.
pub fn sparkline_line(values: &[i64], height_px: f32) -> AnyElement {
    let data = if values.is_empty() {
        vec![0, 0]
    } else if values.len() == 1 {
        vec![values[0], values[0]]
    } else {
        values.to_vec()
    };

    div()
        .w_full()
        .h(px(height_px))
        .with_animation(
            "fuli-sparkline-draw",
            Animation::new(Duration::from_millis(700)),
            move |el, raw_t| {
                let reveal = apple_ease_out(raw_t);
                let series_clone = data.clone();
                el.child(
                    canvas(
                        move |_, _, _| (series_clone, reveal),
                        move |bounds, (series, progress), window, _| {
                            let w = f32::from(bounds.size.width).max(1.0);
                            let h = f32::from(bounds.size.height).max(1.0);
                            let ox = bounds.origin.x;
                            let oy = bounds.origin.y;
                            let pad_x = 4.0;
                            let pad_y = 10.0;
                            let usable_w = (w - pad_x * 2.0).max(1.0);
                            let usable_h = (h - pad_y * 2.0).max(1.0);

                            let min_v = series.iter().copied().min().unwrap_or(0) as f32;
                            let max_v = series.iter().copied().max().unwrap_or(1) as f32;
                            let span = (max_v - min_v).max(1.0);
                            let segments = series.len().saturating_sub(1).max(1);
                            let step_x = usable_w / (segments as f32);

                            // Subtle bottom baseline
                            let mut base = PathBuilder::stroke(px(1.0));
                            base.move_to(point(ox + px(pad_x), oy + px(h - 2.0)));
                            base.line_to(point(ox + px(w - pad_x), oy + px(h - 2.0)));
                            if let Ok(path) = base.build() {
                                window.paint_path(path, colors::border());
                            }

                            // Compute full coordinates
                            let pts: Vec<(f32, f32)> = series
                                .iter()
                                .enumerate()
                                .map(|(idx, &val)| {
                                    let norm = if max_v == min_v {
                                        if max_v > 0.0 { 0.65 } else { 0.12 }
                                    } else {
                                        (val as f32 - min_v) / span
                                    };
                                    let x = pad_x + (idx as f32) * step_x;
                                    let y = pad_y + (1.0 - norm) * usable_h;
                                    (x, y)
                                })
                                .collect();

                            // Progressive left-to-right reveal along the polyline
                            let target_seg_f = progress * (segments as f32);
                            let full_segs = (target_seg_f.floor() as usize).min(segments);
                            let seg_frac = (target_seg_f - full_segs as f32).clamp(0.0, 1.0);

                            let mut drawn: Vec<(f32, f32)> = Vec::with_capacity(pts.len() + 1);
                            drawn.push(pts[0]);
                            for pt in pts.iter().take(full_segs + 1).skip(1) {
                                drawn.push(*pt);
                            }
                            if full_segs < segments && seg_frac > 0.001 {
                                let (x0, y0) = pts[full_segs];
                                let (x1, y1) = pts[full_segs + 1];
                                drawn.push((x0 + (x1 - x0) * seg_frac, y0 + (y1 - y0) * seg_frac));
                            }

                            // Crisp ink polyline
                            let mut line = PathBuilder::stroke(px(1.8));
                            for (idx, &(x, y)) in drawn.iter().enumerate() {
                                let p = point(ox + px(x), oy + px(y));
                                if idx == 0 {
                                    line.move_to(p);
                                } else {
                                    line.line_to(p);
                                }
                            }
                            if let Ok(path) = line.build() {
                                window.paint_path(path, colors::ink());
                            }

                            // Blooming brand gold endpoint dot
                            if let Some(&(lx, ly)) = drawn.last() {
                                let tip = point(ox + px(lx), oy + px(ly));
                                let r = 2.0 + 1.8 * progress;
                                let mut dot = PathBuilder::fill();
                                dot.move_to(point(tip.x + px(r), tip.y));
                                dot.arc_to(
                                    point(px(r), px(r)),
                                    px(0.0),
                                    false,
                                    true,
                                    point(tip.x - px(r), tip.y),
                                );
                                dot.arc_to(
                                    point(px(r), px(r)),
                                    px(0.0),
                                    false,
                                    true,
                                    point(tip.x + px(r), tip.y),
                                );
                                dot.close();
                                if let Ok(path) = dot.build() {
                                    window.paint_path(path, colors::gold());
                                }
                            }
                        },
                    )
                    .size_full(),
                )
            },
        )
        .into_any_element()
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
        .w_full()
        .min_w(px(0.0))
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

/// Red hairline conflict resolution card stacking two conflicting rules cleanly with zero overflow.
pub fn conflict_split_card(
    title: impl Into<SharedString>,
    reason: impl Into<SharedString>,
    first_option: AnyElement,
    second_option: AnyElement,
) -> Div {
    div()
        .w_full()
        .min_w(px(0.0))
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
                .w_full()
                .min_w(px(0.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.0))
                .child(
                    div()
                        .flex_1()
                        .min_w(px(0.0))
                        .text_size(typography::card_title_size())
                        .font_weight(typography::WEIGHT_STRONG)
                        .text_color(colors::danger())
                        .child(title.into()),
                )
                .child(status_badge("需要你二选一", BadgeTone::Danger)),
        )
        .child(
            div()
                .w_full()
                .min_w(px(0.0))
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(reason.into()),
        )
        .child(
            div()
                .w_full()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px(8.0))
                .child(first_option)
                .child(second_option),
        )
}

/// Clean empty state panel in plain human language.
pub fn empty_state(title: impl Into<SharedString>, sub: impl Into<SharedString>) -> Div {
    div()
        .w_full()
        .min_w(px(0.0))
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
        .w_full()
        .min_w(px(0.0))
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

/// Official FULI Brand Compounding Loading bar (real 6-layer animated mark + plain-language label).
pub fn growth_loading(label: impl Into<SharedString>) -> AnyElement {
    crate::brand::fuli_loading(
        "growth-loading-mark",
        crate::brand::LoadingSize::Compact,
        label,
    )
}

/// Top-right minimal outline icon button (matching v0.27.16 header calm), safe inside immersive titlebar.
pub fn top_icon_button(id: impl Into<ElementId>, icon_name: &str, active: bool) -> Stateful<Div> {
    let icon_color = if active {
        colors::ink()
    } else {
        colors::muted()
    };
    let base = div()
        .id(id.into())
        .size(px(32.0))
        .flex_shrink_0()
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, window, cx| {
            window.prevent_default();
            cx.stop_propagation();
        })
        .active(|s| s.bg(rgb(0xe4e1d8)).pt(px(1.0)))
        .child(crate::brand::fuli_icon(icon_name, 16.0, icon_color));

    if active {
        base.bg(colors::surface())
            .border_1()
            .border_color(colors::control_border())
    } else {
        base.hover(|style| style.bg(colors::hover()))
    }
}

/// Top-bar warm floating status pill (`● 有 N 件事需要你`), clickable to jump straight to decisions.
/// Features a calm breathing gold dot when items need attention and drag-safe click handling.
pub fn status_pill_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    urgent: bool,
) -> Stateful<Div> {
    let elem_id: ElementId = id.into();
    let dot_el: AnyElement = if urgent {
        live_pulse_dot(
            ElementId::NamedChild(elem_id.clone().into(), "pulse".into()),
            7.0,
            colors::gold(),
        )
    } else {
        div()
            .size(px(7.0))
            .rounded(layout::radius_pill())
            .bg(colors::success())
            .into_any_element()
    };

    div()
        .id(elem_id)
        .h(px(30.0))
        .px(px(12.0))
        .flex_shrink_0()
        .rounded(layout::radius_pill())
        .bg(colors::surface())
        .border_1()
        .border_color(colors::border())
        .flex()
        .items_center()
        .gap(px(7.0))
        .cursor_pointer()
        .on_mouse_down(MouseButton::Left, |_, window, cx| {
            window.prevent_default();
            cx.stop_propagation();
        })
        .hover(|style| {
            style
                .bg(colors::subtle())
                .border_color(colors::control_border())
        })
        .active(|style| style.bg(colors::hover()).pt(px(1.0)))
        .child(dot_el)
        .child(
            div()
                .text_size(typography::meta_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(label.into()),
        )
}

/// Left-sidebar hierarchical navigation item (exact v0.27.16 Settings/Category style).
pub fn sidebar_nav_item(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    active: bool,
    indented: bool,
) -> Stateful<Div> {
    let left_pad = if indented { px(24.0) } else { px(12.0) };
    let base = div()
        .id(id.into())
        .w_full()
        .h(px(32.0))
        .pl(left_pad)
        .pr(px(12.0))
        .rounded(layout::radius_control())
        .text_size(typography::control_size())
        .flex()
        .items_center()
        .cursor_pointer()
        .active(|s| s.opacity(0.78));

    if active {
        base.bg(colors::surface())
            .border_1()
            .border_color(colors::border())
            .text_color(colors::ink())
            .font_weight(typography::WEIGHT_STRONG)
            .child(label.into())
    } else {
        base.text_color(colors::muted())
            .font_weight(typography::WEIGHT_REGULAR)
            .hover(|style| style.bg(colors::hover()).text_color(colors::ink()))
            .child(label.into())
    }
}

/// Clean settings row pairing title + subtle description on the left with a crisp ink Switch on the right.
pub fn setting_toggle_row(
    id: impl Into<ElementId>,
    title: impl Into<SharedString>,
    subtitle: impl Into<SharedString>,
    checked: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> Div {
    div()
        .w_full()
        .min_w(px(0.0))
        .py(px(14.0))
        .border_b_1()
        .border_color(colors::border())
        .flex()
        .items_center()
        .justify_between()
        .gap(px(16.0))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px(3.0))
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
        )
        .child(toggle_switch(id, checked, on_change))
}

/// Reusable FULI application shell with seamless immersive Windows/macOS frameless title bar,
/// generous zero-overflow main canvas, and warm BOTTOM-LEFT floating capsule dock.
pub fn fuli_shell(
    top_left: AnyElement,
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
        .child(FuliTitleBar::new(top_left, top_right))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .px(px(24.0))
                .pt(px(16.0))
                .pb(px(22.0))
                .flex()
                .child(main_content),
        )
        .child(
            div()
                .absolute()
                .bottom(px(18.0))
                .left(px(24.0))
                .child(dock_content),
        )
}

/// Warm frosted floating capsule dock anchored bottom-left (v0.27.16 signature look).
pub fn floating_dock() -> Div {
    div()
        .bg(rgba(0xfafaf6f5))
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
            color: hsla(0.08, 0.14, 0.14, 0.12),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(24.0),
            spread_radius: px(0.0),
        }])
}

/// Icon-first destination button inside `floating_dock` (shows active pill highlight + crisp label when active).
pub fn dock_icon_item(
    id: impl Into<ElementId>,
    icon_name: &str,
    label: impl Into<SharedString>,
    active: bool,
) -> Stateful<Div> {
    let icon_color = if active {
        colors::ink()
    } else {
        colors::muted()
    };
    let mut item = div()
        .id(id.into())
        .h(px(34.0))
        .px(if active { px(12.0) } else { px(10.0) })
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .justify_center()
        .gap(px(6.0))
        .cursor_pointer()
        .child(crate::brand::fuli_icon(icon_name, 17.0, icon_color));

    if active {
        item = item
            .bg(colors::surface())
            .border_1()
            .border_color(colors::border())
            .shadow(vec![BoxShadow {
                inset: false,
                color: hsla(0.0, 0.0, 0.09, 0.06),
                offset: point(px(0.0), px(2.0)),
                blur_radius: px(6.0),
                spread_radius: px(0.0),
            }])
            .child(
                div()
                    .text_size(typography::meta_size())
                    .font_weight(typography::WEIGHT_STRONG)
                    .text_color(colors::ink())
                    .child(label.into()),
            );
    } else {
        item = item.hover(|style| style.bg(colors::hover()));
    }
    item
}

/// Text destination item inside `floating_dock` (retained for flexible dock variants).
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
