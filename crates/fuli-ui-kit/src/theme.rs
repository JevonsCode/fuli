use gpui_kit::{App, Hsla, component::Theme};

use crate::tokens::{colors, layout};

/// Synchronize `gpui-component`'s global `Theme` with FULI's light minimalist palette
/// so native `Input`, `Switch`, focus rings, carets, and scrollbars never drift in color.
///
/// Call once right after `gpui_kit::init(cx)`.
pub fn apply_fuli_theme(cx: &mut App) {
    Theme::update(cx, |theme| {
        theme.radius = layout::radius_control();
        theme.radius_lg = layout::radius_card();

        let c = &mut theme.colors;
        c.background = Hsla::from(colors::surface());
        c.foreground = Hsla::from(colors::ink());
        c.border = Hsla::from(colors::border());
        c.input = Hsla::from(colors::control_border());
        c.caret = Hsla::from(colors::ink());
        c.accent = Hsla::from(colors::subtle());
        c.accent_foreground = Hsla::from(colors::ink());
        c.muted = Hsla::from(colors::subtle());
        c.muted_foreground = Hsla::from(colors::muted());
        c.list = Hsla::from(colors::surface());
        c.list_hover = Hsla::from(colors::subtle());
        c.list_active = Hsla::from(colors::hover());
        c.list_active_border = Hsla::from(colors::ink());
        c.danger = Hsla::from(colors::danger());
        c.danger_foreground = Hsla::from(colors::surface());
        c.success = Hsla::from(colors::success());
        c.success_foreground = Hsla::from(colors::surface());
        c.warning = Hsla::from(colors::warning());
        c.warning_foreground = Hsla::from(colors::surface());
    });
}
