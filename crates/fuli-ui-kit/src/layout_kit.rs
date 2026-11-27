//! Immersive Windows/macOS Frameless Titlebar, Avatars (deterministic warm-toned seeds + working pulse ring),
//! reusable Sidebars, Apple Spring-Gliding Segmented Controls, Zero-Overflow Page Layouts & Spring Dock.

use gpui_kit::{
    AnyElement, App, Bounds, ClickEvent, Decorations, ElementId, InteractiveElement, IntoElement,
    MouseButton, ParentElement, Pixels, RenderOnce, SharedString, Size, Stateful,
    StatefulInteractiveElement as _, Styled, TitlebarOptions, Window, WindowBounds,
    WindowControlArea, WindowOptions,
    component::{Icon, IconName, Sizable as _},
    div, point, px, rgb, rgba,
};

use crate::brand::fuli_icon;
use crate::motion::{
    live_pulse_dot, spring_dock_indicator, spring_segmented_pill, working_ring_wrap,
};
use crate::primitives::{floating_dock, scroll_area};
use crate::tokens::{colors, layout, typography};

// ============================================================================
// Immersive Frameless Window Options & Unified Windows/macOS Title Bar
// ============================================================================

/// Standard immersive frameless window configuration for FULI (`fuli-ui` & `gallery`).
///
/// - **Windows**: hides the white OS title bar while preserving native Windows 11 rounded corners,
///   drop shadow, resize borders, Aero Snap, and Snap Layouts (`WindowControlArea`).
/// - **macOS**: transparent title bar with vertically centered traffic lights inside our 52px header.
pub fn fuli_window_options(bounds: Bounds<Pixels>, min_size: Size<Pixels>) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(min_size),
        titlebar: Some(TitlebarOptions {
            title: None,
            appears_transparent: true,
            traffic_light_position: Some(point(px(16.0), px(18.0))),
        }),
        app_owns_titlebar_drag: true,
        ..WindowOptions::default()
    }
}

/// Unified seamless top bar combining app branding/actions with native window dragging & caption controls.
#[derive(IntoElement)]
pub struct FuliTitleBar {
    left: AnyElement,
    right: AnyElement,
}

impl FuliTitleBar {
    pub fn new(left: AnyElement, right: AnyElement) -> Self {
        Self { left, right }
    }
}

fn caption_control_button(
    id: &'static str,
    icon: IconName,
    area: WindowControlArea,
    is_close: bool,
    on_linux_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let is_windows = cfg!(target_os = "windows");
    let is_linux = cfg!(target_os = "linux");

    let mut btn = div()
        .id(id)
        .w(px(44.0))
        .h_full()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .text_color(colors::muted())
        .cursor_pointer();

    if is_close {
        btn = btn
            .hover(|s| s.bg(rgb(0xe81123)).text_color(rgb(0xffffff)))
            .active(|s| s.bg(rgb(0xc50f1f)).text_color(rgb(0xffffff)));
    } else {
        btn = btn
            .hover(|s| s.bg(colors::hover()).text_color(colors::ink()))
            .active(|s| s.bg(rgb(0xe4e1d8)).text_color(colors::ink()));
    }

    if is_windows {
        btn = btn.window_control_area(area);
    }

    if is_linux {
        btn = btn
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(move |ev, window, cx| {
                cx.stop_propagation();
                on_linux_click(ev, window, cx);
            });
    }

    btn.child(Icon::new(icon).small()).into_any_element()
}

impl RenderOnce for FuliTitleBar {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let is_macos = cfg!(target_os = "macos");
        let is_windows = cfg!(target_os = "windows");
        let is_linux = cfg!(target_os = "linux");
        let is_client_decorated = matches!(window.window_decorations(), Decorations::Client { .. });
        let show_caption_buttons = is_windows || (is_linux && is_client_decorated);
        let left_pad = if is_macos && !window.is_fullscreen() {
            px(82.0)
        } else {
            px(22.0)
        };
        let right_pad = if show_caption_buttons {
            px(0.0)
        } else {
            px(22.0)
        };
        let is_maximized = window.is_maximized();

        let mut bar = div()
            .id("fuli-immersive-titlebar")
            .w_full()
            .h(px(52.0))
            .pl(left_pad)
            .pr(right_pad)
            .bg(colors::canvas())
            .border_b_1()
            .border_color(colors::border())
            .flex()
            .items_center()
            .justify_between()
            .flex_shrink_0();

        if is_macos {
            bar = bar.on_click(|ev, window, _| {
                if ev.click_count() == 2 {
                    window.titlebar_double_click();
                }
            });
        } else if is_linux {
            bar = bar.on_click(|ev, window, _| {
                if ev.click_count() == 2 {
                    window.zoom_window();
                }
            });
        }

        // Empty center drag bridge: full native Windows HTCAPTION drag + double-click maximize
        let mut drag_bridge = div()
            .id("fuli-titlebar-drag-bridge")
            .flex_1()
            .min_w(px(24.0))
            .h_full()
            .window_control_area(WindowControlArea::Drag)
            .on_mouse_down(MouseButton::Left, |_, window, _| {
                if cfg!(not(target_os = "windows")) {
                    window.start_window_move();
                }
            });

        if is_linux && is_client_decorated {
            drag_bridge = drag_bridge.on_mouse_down(MouseButton::Right, |ev, window, _| {
                window.show_window_menu(ev.position);
            });
        }

        // Left slot: brand lockup & optional sub-tabs (non-button space stays draggable)
        let left_slot = div()
            .h_full()
            .flex()
            .items_center()
            .flex_shrink_0()
            .child(self.left);

        // Right slot: app status pill + icon buttons + subtle divider + Windows caption controls
        let mut right_slot = div()
            .h_full()
            .flex()
            .items_center()
            .flex_shrink_0()
            .child(self.right);

        if show_caption_buttons {
            let max_icon = if is_maximized {
                IconName::WindowRestore
            } else {
                IconName::WindowMaximize
            };
            right_slot = right_slot
                .child(
                    div()
                        .w(px(1.0))
                        .h(px(18.0))
                        .mx(px(10.0))
                        .bg(colors::border()),
                )
                .child(
                    div()
                        .h_full()
                        .flex()
                        .items_center()
                        .child(caption_control_button(
                            "win-btn-min",
                            IconName::WindowMinimize,
                            WindowControlArea::Min,
                            false,
                            |_, window, _| window.minimize_window(),
                        ))
                        .child(caption_control_button(
                            "win-btn-max",
                            max_icon,
                            WindowControlArea::Max,
                            false,
                            |_, window, _| window.zoom_window(),
                        ))
                        .child(caption_control_button(
                            "win-btn-close",
                            IconName::WindowClose,
                            WindowControlArea::Close,
                            true,
                            |_, window, _| window.remove_window(),
                        )),
                );
        }

        bar.child(left_slot).child(drag_bridge).child(right_slot)
    }
}

// ============================================================================
// Apple-Style Spring-Gliding Segmented Control
// ============================================================================

/// Equal-width Apple-style segmented control where the active white pill glides smoothly
/// with velocity-preserving spring physics across options.
pub fn spring_segmented_control(
    indicator_id: impl Into<ElementId>,
    active_index: usize,
    segment_width_px: f32,
    items: Vec<AnyElement>,
) -> AnyElement {
    let gap = 3.0_f32;
    let height = 28.0_f32;
    let mut row = div()
        .relative()
        .flex()
        .items_center()
        .gap(px(gap))
        .child(spring_segmented_pill(
            indicator_id,
            active_index,
            segment_width_px,
            gap,
            height,
        ));

    for item in items {
        row = row.child(item);
    }

    div()
        .p(px(3.0))
        .rounded(px(9.0))
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .flex_shrink_0()
        .on_mouse_down(MouseButton::Left, |_, window, cx| {
            window.prevent_default();
            cx.stop_propagation();
        })
        .child(row)
        .into_any_element()
}

/// Single option slot inside `spring_segmented_control` (matches `segment_width_px`).
pub fn spring_segment_slot(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    width_px: f32,
    active: bool,
) -> Stateful<gpui_kit::Div> {
    div()
        .id(id.into())
        .w(px(width_px))
        .h(px(28.0))
        .rounded(px(7.0))
        .flex()
        .items_center()
        .justify_center()
        .text_size(typography::control_size())
        .font_weight(if active {
            typography::WEIGHT_STRONG
        } else {
            typography::WEIGHT_MEDIUM
        })
        .text_color(if active {
            colors::ink()
        } else {
            colors::muted()
        })
        .cursor_pointer()
        .hover(move |s| {
            if active {
                s
            } else {
                s.text_color(colors::ink())
            }
        })
        .active(|s| s.opacity(0.75))
        .child(label.into())
}

// ============================================================================
// Deterministic Avatars, Working Ring & Avatar Stack
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarSize {
    Sm, // 26px
    Md, // 34px
    Lg, // 44px
}

impl AvatarSize {
    pub fn px(self) -> f32 {
        match self {
            Self::Sm => 26.0,
            Self::Md => 34.0,
            Self::Lg => 44.0,
        }
    }

    pub fn font_px(self) -> f32 {
        match self {
            Self::Sm => 11.0,
            Self::Md => 13.0,
            Self::Lg => 16.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarPresence {
    None,
    Online,
    Working,
    Attention,
}

const AVATAR_PALETTE: [(u32, u32); 6] = [
    (0xf3ece0, 0x7c5b2b), // warm parchment + gold ink
    (0xe6f4ef, 0x087b63), // sage mint + emerald
    (0xedf0f7, 0x334155), // cool slate + ink
    (0xf5ece8, 0x8a4b38), // terracotta clay
    (0xefeaf6, 0x5b4682), // muted iris
    (0xebf3f5, 0x265c6b), // mist teal
];

fn deterministic_seed_index(seed: &str) -> usize {
    let mut hash: u32 = 2166136261;
    for b in seed.as_bytes() {
        hash ^= u32::from(*b);
        hash = hash.wrapping_mul(16777619);
    }
    (hash as usize) % AVATAR_PALETTE.len()
}

fn initials_for(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "FL".into();
    }
    let first_char = trimmed.chars().next().unwrap_or('F');
    if !first_char.is_ascii() {
        return first_char.to_string();
    }
    let parts: Vec<&str> = trimmed
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() >= 2 {
        let a = parts[0].chars().next().unwrap_or('F');
        let b = parts[1].chars().next().unwrap_or('L');
        format!("{}{}", a.to_ascii_uppercase(), b.to_ascii_uppercase())
    } else {
        trimmed
            .chars()
            .take(2)
            .collect::<String>()
            .to_ascii_uppercase()
    }
}

/// Calm deterministic Agent/Project Avatar with optional working breathing ring
/// (ported from legacy `agent-profile.css`) and status dot.
pub fn fuli_avatar(
    id: impl Into<ElementId>,
    name: &str,
    size: AvatarSize,
    presence: AvatarPresence,
) -> AnyElement {
    let dim = size.px();
    let (bg_hex, fg_hex) = AVATAR_PALETTE[deterministic_seed_index(name)];
    let label = initials_for(name);
    let elem_id: ElementId = id.into();

    let mut circle = div()
        .size(px(dim))
        .rounded(layout::radius_pill())
        .bg(rgb(bg_hex))
        .border_1()
        .border_color(colors::border())
        .flex()
        .items_center()
        .justify_center()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .text_size(px(size.font_px()))
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(rgb(fg_hex))
                .child(label),
        );

    let dot_size = (dim * 0.28).clamp(7.0, 11.0);
    match presence {
        AvatarPresence::Online => {
            circle = circle.child(
                div()
                    .absolute()
                    .bottom(px(-1.0))
                    .right(px(-1.0))
                    .size(px(dot_size))
                    .rounded(layout::radius_pill())
                    .bg(colors::success())
                    .border_2()
                    .border_color(colors::surface()),
            );
        }
        AvatarPresence::Attention => {
            circle = circle.child(
                div()
                    .absolute()
                    .bottom(px(-1.0))
                    .right(px(-1.0))
                    .size(px(dot_size))
                    .rounded(layout::radius_pill())
                    .bg(colors::gold())
                    .border_2()
                    .border_color(colors::surface()),
            );
        }
        AvatarPresence::Working => {
            circle = circle.child(div().absolute().bottom(px(-1.0)).right(px(-1.0)).child(
                live_pulse_dot(
                    ElementId::NamedChild(elem_id.clone().into(), "dot".into()),
                    dot_size,
                    colors::gold(),
                ),
            ));
            return working_ring_wrap(
                ElementId::NamedChild(elem_id.into(), "ring".into()),
                dim + 6.0,
                colors::gold(),
                circle.into_any_element(),
            );
        }
        AvatarPresence::None => {}
    }

    circle.into_any_element()
}

/// Overlapping Avatar stack showing collaborating project agents (with `+N` overflow badge).
pub fn avatar_group(
    prefix: &str,
    names: &[String],
    max_visible: usize,
    size: AvatarSize,
) -> AnyElement {
    let mut row = div().flex().items_center();
    let shown = names.len().min(max_visible);
    for (idx, name) in names.iter().take(shown).enumerate() {
        let mut slot = div().child(fuli_avatar(
            format!("{prefix}-av-{idx}"),
            name,
            size,
            AvatarPresence::None,
        ));
        if idx > 0 {
            slot = slot.ml(px(-8.0));
        }
        row = row.child(slot);
    }
    if names.len() > max_visible {
        let extra = names.len() - max_visible;
        row = row.child(
            div()
                .ml(px(-8.0))
                .size(px(size.px()))
                .rounded(layout::radius_pill())
                .bg(colors::subtle())
                .border_1()
                .border_color(colors::control_border())
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(size.font_px() - 1.0))
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::muted())
                .child(format!("+{extra}")),
        );
    }
    row.into_any_element()
}

// ============================================================================
// Reusable Sidebar & Canonical Zero-Overflow FULI Page Layouts
// ============================================================================

/// Subtle uppercase/medium category header inside a left sidebar.
pub fn sidebar_group_label(label: impl Into<SharedString>) -> AnyElement {
    div()
        .px(px(12.0))
        .pt(px(10.0))
        .pb(px(4.0))
        .text_size(typography::meta_size())
        .font_weight(typography::WEIGHT_STRONG)
        .text_color(colors::ink())
        .child(label.into())
        .into_any_element()
}

/// Complete reusable left sidebar container (optional top search slot + nav list + bottom footer,
/// padded at the bottom to clear the bottom-left floating dock cleanly).
pub fn sidebar_panel(
    width_px: f32,
    top_slot: Option<AnyElement>,
    items: Vec<AnyElement>,
    footer_slot: Option<AnyElement>,
) -> AnyElement {
    let mut body = div().flex().flex_col().gap(px(3.0));
    if let Some(top) = top_slot {
        body = body.child(div().pb(px(8.0)).child(top));
    }
    for item in items {
        body = body.child(item);
    }

    let mut rail = div()
        .w(px(width_px))
        .min_h(px(0.0))
        .pb(px(66.0))
        .flex()
        .flex_col()
        .justify_between()
        .flex_shrink_0()
        .child(body);

    if let Some(footer) = footer_slot {
        rail = rail.child(footer);
    }
    rail.into_any_element()
}

/// Canonical v0.27.16 Layout 1: Left fixed visual stage + Right independently scrollable feed.
/// Both panes enforce `min_w(0)` so long text always wraps cleanly without horizontal overflow.
pub fn split_workbench_layout(
    left_fixed: AnyElement,
    right_scroll_id: impl Into<ElementId>,
    right_stream: gpui_kit::Div,
) -> gpui_kit::Div {
    div()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .flex()
        .gap(px(18.0))
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .pb(px(62.0))
                .flex()
                .flex_col()
                .child(left_fixed),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .child(scroll_area(right_scroll_id, right_stream)),
        )
}

/// Canonical v0.27.16 Layout 2: Left fixed category sidebar + Right independently scrollable cards.
pub fn sidebar_content_layout(
    sidebar: AnyElement,
    content_scroll_id: impl Into<ElementId>,
    content: gpui_kit::Div,
) -> gpui_kit::Div {
    div()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .flex()
        .gap(px(18.0))
        .child(sidebar)
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .min_h(px(0.0))
                .flex()
                .flex_col()
                .child(scroll_area(content_scroll_id, content)),
        )
}

// ============================================================================
// Signature v0.29 / Apple Spring-Gliding Bottom-Left Capsule Dock
// ============================================================================

/// Single 42×42px circular icon slot inside `spring_floating_dock` with tactile active press.
pub fn spring_dock_slot(
    id: impl Into<ElementId>,
    icon_name: &str,
    active: bool,
) -> Stateful<gpui_kit::Div> {
    let icon_color = if active {
        colors::ink()
    } else {
        colors::muted()
    };
    div()
        .id(id.into())
        .size(px(42.0))
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .hover(move |s| if active { s } else { s.bg(rgba(0x17171a0d)) })
        .active(|s| s.bg(rgba(0x17171a18)).pt(px(1.0)))
        .child(fuli_icon(icon_name, 18.0, icon_color))
}

/// Warm frosted bottom-left capsule dock with velocity-preserving Apple spring-gliding
/// active highlight pill + gold dot (exact v0.27.16 / v0.29 `AppDock.vue` minimal look).
pub fn spring_floating_dock(
    indicator_id: impl Into<ElementId>,
    active_index: usize,
    slots: Vec<AnyElement>,
) -> AnyElement {
    let mut row = div()
        .relative()
        .flex()
        .items_center()
        .gap(px(4.0))
        .child(spring_dock_indicator(indicator_id, active_index, 42.0, 4.0));

    for slot in slots {
        row = row.child(slot);
    }

    floating_dock()
        .px(px(6.0))
        .py(px(5.0))
        .child(row)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_avatar_seed_and_initials_are_stable() {
        assert_eq!(
            deterministic_seed_index("PhoneBridge"),
            deterministic_seed_index("PhoneBridge")
        );
        assert_eq!(initials_for("PhoneBridge"), "PH");
        assert_eq!(initials_for("FULI Agent"), "FA");
        assert_eq!(initials_for("潮池账本"), "潮");
    }
}
