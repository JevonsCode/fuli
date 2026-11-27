//! Apple-calibrated native GPUI physics spring & fluid transition system for FULI.
//!
//! Built directly on GPUI's velocity-preserving `SpringAnimation` (`with_spring`)
//! and `gpui_kit::base::motion` (`Easing::cubic_bezier`, `MotionReveal`), automatically
//! honoring OS `prefers-reduced-motion` (`App::reduce_motion`).

use std::f32::consts::PI;
use std::time::Duration;

use gpui_kit::base::motion::{Easing, MotionReveal};
use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, ElementId, Hsla, IntoElement, ParentElement, Pixels,
    SpringAnimation, SpringConfig, Styled, div, px, relative,
};

use crate::tokens::{colors, layout};

/// Apple SwiftUI-calibrated spring physics presets tuned for silky, magnetic desktop motion
/// (high initial responsiveness, whisper-smooth asymptotic settle, zero cartoon jitter).
pub struct FuliSpring;

impl FuliSpring {
    /// Crisp Apple `.snappy` feel for toggles, buttons, checkmarks, and chips (~210ms settle).
    pub fn snappy() -> SpringConfig {
        SpringConfig::new(430.0, 32.0, 1.0)
    }

    /// Signature fluid spring glide for the bottom-left Dock & segmented pickers
    /// (preserves mid-flight velocity when rapidly switching targets, ported from v0.29 AppDock).
    pub fn dock_glide() -> SpringConfig {
        SpringConfig::new(360.0, 27.0, 1.0)
    }

    /// Apple `.smooth` critically-damped feel for page switches, modals, drawers, and dropdowns.
    pub fn surface_enter() -> SpringConfig {
        SpringConfig::new(280.0, 29.0, 1.0)
    }

    /// Delicate floating sheet spring for toasts & guided tour popovers.
    pub fn sheet_float() -> SpringConfig {
        SpringConfig::new(330.0, 27.0, 1.0)
    }

    /// Gentle spring for expanding accordions, progress bars, and collapsible panels.
    pub fn gentle() -> SpringConfig {
        SpringConfig::new(230.0, 26.0, 1.0)
    }
}

/// Apple signature fast-out, long-silky-tail cubic-bezier easing (`[0.22, 1.0, 0.36, 1.0]`).
#[inline]
pub fn apple_ease_out(t: f32) -> f32 {
    let clamped = t.clamp(0.0, 1.0);
    Easing::cubic_bezier(0.22, 1.0, 0.36, 1.0)
        .map(|e| e.sample(clamped))
        .unwrap_or_else(|_| 1.0 - (1.0 - clamped).powi(4))
}

/// Natural Apple spring entrance wrapper: animates subtle offset (`from_x`, `from_y`) -> `(0, 0)`
/// plus smooth opacity `0.0 -> 1.0` with real physics and automatic `reduce_motion` compliance.
pub fn spring_entrance(
    id: impl Into<ElementId>,
    from_x: f32,
    from_y: f32,
    child: AnyElement,
) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::surface_enter())
        .to(1.0_f32)
        .from(0.0_f32);
    div()
        .with_spring(id.into(), spring, move |el, p| {
            let clamped = p.clamp(0.0, 1.0);
            let dx = from_x * (1.0 - p);
            let dy = from_y * (1.0 - p);
            el.opacity(clamped).ml(px(dx)).mt(px(dy)).child(child)
        })
        .into_any_element()
}

/// Floating toast / popover entrance with slightly livelier Apple sheet physics.
pub fn sheet_spring_entrance(
    id: impl Into<ElementId>,
    from_x: f32,
    from_y: f32,
    child: AnyElement,
) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::sheet_float())
        .to(1.0_f32)
        .from(0.0_f32);
    div()
        .with_spring(id.into(), spring, move |el, p| {
            let clamped = p.clamp(0.0, 1.0);
            let dx = from_x * (1.0 - p);
            let dy = from_y * (1.0 - p);
            el.opacity(clamped).ml(px(dx)).mt(px(dy)).child(child)
        })
        .into_any_element()
}

/// Silky Apple-style view / tab / detail-panel transition (`flex_1`, `min_w_0`, `min_h_0`).
/// Key the `id` by the active tab or selection so switching triggers a fresh fluid glide-in.
pub fn apple_view_transition(id: impl Into<ElementId>, child: AnyElement) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::surface_enter())
        .to(1.0_f32)
        .from(0.0_f32);
    div()
        .flex_1()
        .min_w(px(0.0))
        .min_h(px(0.0))
        .flex()
        .flex_col()
        .with_spring(id.into(), spring, move |el, p| {
            let alpha = (p * 1.15).clamp(0.0, 1.0);
            let dy = 8.0 * (1.0 - p).max(-0.2);
            el.opacity(alpha).mt(px(dy)).child(child)
        })
        .into_any_element()
}

/// Subtle staggered cascade entrance for cards & list rows (capped at 5 steps so lists stay instant).
pub fn apple_stagger_card(id: impl Into<ElementId>, index: usize, child: AnyElement) -> AnyElement {
    let step = index.min(5) as f32;
    let total_ms = 240 + (step as u64) * 42;
    let delay_ratio = (step * 0.11).min(0.45);

    div()
        .w_full()
        .min_w(px(0.0))
        .child(child)
        .with_animation(
            id.into(),
            Animation::new(Duration::from_millis(total_ms)),
            move |el, raw_t| {
                let local_t = if raw_t <= delay_ratio {
                    0.0
                } else {
                    ((raw_t - delay_ratio) / (1.0 - delay_ratio)).clamp(0.0, 1.0)
                };
                let eased = apple_ease_out(local_t);
                let dy = 8.0 * (1.0 - eased);
                el.opacity(eased).mt(px(dy))
            },
        )
        .into_any_element()
}

/// Smooth translucent scrim fade for modals, alerts, and right-hand drawers (180ms Apple ease-out).
pub fn backdrop_fade(
    id: impl Into<ElementId>,
    target_bg: impl Into<Hsla>,
    child: gpui_kit::Div,
) -> AnyElement {
    let base: Hsla = target_bg.into();
    child
        .with_animation(
            id.into(),
            Animation::new(Duration::from_millis(180)),
            move |el, t| {
                let eased = apple_ease_out(t);
                el.bg(base.opacity(base.a * eased))
            },
        )
        .into_any_element()
}

/// Smooth measured-height collapsible container powered by GPUI `SpringAnimation` + `MotionReveal`.
pub fn collapsible_reveal(id: impl Into<ElementId>, open: bool, child: AnyElement) -> AnyElement {
    let elem_id: ElementId = id.into();
    let reveal_id = ElementId::NamedChild(elem_id.clone().into(), "reveal".into());
    let target = if open { 1.0_f32 } else { 0.0_f32 };
    let spring = SpringAnimation::new(FuliSpring::gentle()).to(target);

    div()
        .w_full()
        .min_w(px(0.0))
        .with_spring(elem_id, spring, move |el, progress| {
            let p = progress.clamp(0.0, 1.0);
            el.opacity(p).child(MotionReveal::new(reveal_id, p, child))
        })
        .into_any_element()
}

/// Smooth spring-animated horizontal progress / budget bar (`ratio` clamped to `0.0..=1.0`).
pub fn progress_bar_animated(
    id: impl Into<ElementId>,
    ratio: f32,
    fill_color: impl Into<Hsla>,
) -> AnyElement {
    let clamped = ratio.clamp(0.0, 1.0);
    let fill: Hsla = fill_color.into();
    let spring = SpringAnimation::new(FuliSpring::gentle()).to(clamped);

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
                .rounded(layout::radius_pill())
                .bg(fill)
                .with_spring(id.into(), spring, |el, p| el.w(relative(p.clamp(0.0, 1.0)))),
        )
        .into_any_element()
}

/// Soft breathing pulse dot (ported from legacy `FlaNow.vue` `@keyframes now-dot`).
pub fn live_pulse_dot(
    id: impl Into<ElementId>,
    size_px: f32,
    color: impl Into<Hsla>,
) -> AnyElement {
    let base_color: Hsla = color.into();
    div()
        .size(px(size_px))
        .rounded(layout::radius_pill())
        .flex_shrink_0()
        .with_animation(
            id.into(),
            Animation::new(Duration::from_millis(2400)).repeat_synced(),
            move |el, t| {
                let wave = 0.5 - 0.5 * (t * 2.0 * PI).cos();
                let opacity = 0.42 + 0.58 * wave;
                el.bg(base_color.opacity(opacity))
            },
        )
        .into_any_element()
}

/// Breathing halo ring around an active working Agent's avatar
/// (ported from legacy `agent-profile.css` `@keyframes agent-working-ring`).
pub fn working_ring_wrap(
    id: impl Into<ElementId>,
    outer_px: f32,
    ring_color: impl Into<Hsla>,
    child: AnyElement,
) -> AnyElement {
    let base: Hsla = ring_color.into();
    div()
        .size(px(outer_px))
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .justify_center()
        .relative()
        .flex_shrink_0()
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded(layout::radius_pill())
                .border_2()
                .with_animation(
                    id.into(),
                    Animation::new(Duration::from_millis(2200)).repeat_synced(),
                    move |el, t| {
                        let wave = 0.5 - 0.5 * (t * 2.0 * PI).cos();
                        let alpha = 0.25 + 0.65 * wave;
                        el.border_color(base.opacity(alpha))
                    },
                ),
        )
        .child(child)
        .into_any_element()
}

/// Smooth horizontal spring-gliding active pill + gold indicator dot for the bottom-left Dock
/// (ported from legacy `AppDock.vue` `<motion.span layout-id="app-dock-active" :transition="SPRING" />`).
pub fn spring_dock_indicator(
    id: impl Into<ElementId>,
    active_index: usize,
    slot_size_px: f32,
    gap_px: f32,
) -> AnyElement {
    let target_x = (active_index as f32) * (slot_size_px + gap_px);
    let spring = SpringAnimation::new(FuliSpring::dock_glide()).to(target_x);

    div()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .size(px(slot_size_px))
        .with_spring(id.into(), spring, move |el, x| {
            el.ml(px(x))
                .rounded(layout::radius_pill())
                .bg(colors::surface())
                .border_1()
                .border_color(colors::border())
                .shadow(vec![gpui_kit::BoxShadow {
                    inset: false,
                    color: gpui_kit::hsla(0.08, 0.12, 0.10, 0.08),
                    offset: gpui_kit::point(px(0.0), px(2.0)),
                    blur_radius: px(8.0),
                    spread_radius: px(0.0),
                }])
                .flex()
                .items_end()
                .justify_center()
                .pb(px(5.0))
                .child(
                    div()
                        .size(px(4.5))
                        .rounded(layout::radius_pill())
                        .bg(colors::gold()),
                )
        })
        .into_any_element()
}

/// Apple-style spring-gliding segmented control pill background.
/// Slides smoothly across equal-width segment buttons while preserving velocity on rapid clicks.
pub fn spring_segmented_pill(
    id: impl Into<ElementId>,
    active_index: usize,
    segment_width_px: f32,
    gap_px: f32,
    height_px: f32,
) -> AnyElement {
    let target_x = (active_index as f32) * (segment_width_px + gap_px);
    let spring = SpringAnimation::new(FuliSpring::dock_glide()).to(target_x);

    div()
        .absolute()
        .top(px(0.0))
        .left(px(0.0))
        .w(px(segment_width_px))
        .h(px(height_px))
        .with_spring(id.into(), spring, move |el, x| {
            el.ml(px(x))
                .rounded(px(7.0))
                .bg(colors::surface())
                .border_1()
                .border_color(colors::border())
                .shadow(vec![gpui_kit::BoxShadow {
                    inset: false,
                    color: gpui_kit::hsla(0.0, 0.0, 0.08, 0.07),
                    offset: gpui_kit::point(px(0.0), px(1.0)),
                    blur_radius: px(4.0),
                    spread_radius: px(0.0),
                }])
        })
        .into_any_element()
}

/// Animated auto-dismiss countdown bar rendered along the bottom of temporary toasts.
pub fn toast_countdown_bar(
    id: impl Into<ElementId>,
    duration: Duration,
    color: impl Into<Hsla>,
) -> AnyElement {
    let fill: Hsla = color.into();
    div()
        .w_full()
        .h(px(2.5))
        .rounded(layout::radius_pill())
        .bg(colors::border())
        .overflow_hidden()
        .child(div().h_full().bg(fill).with_animation(
            id.into(),
            Animation::new(duration),
            |el, t| {
                let rem = (1.0 - t).clamp(0.0, 1.0);
                el.w(relative(rem))
            },
        ))
        .into_any_element()
}

/// Helper to interpolate pixel offsets cleanly in custom motion builders.
#[inline]
pub fn lerp_px(from: f32, to: f32, t: f32) -> Pixels {
    px(from + (to - from) * t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spring_presets_and_apple_curve_are_well_behaved() {
        for cfg in [
            FuliSpring::snappy(),
            FuliSpring::dock_glide(),
            FuliSpring::surface_enter(),
            FuliSpring::sheet_float(),
            FuliSpring::gentle(),
        ] {
            assert!(cfg.stiffness > 100.0);
            assert!(cfg.damping > 10.0);
            assert!(cfg.mass > 0.0);
        }
        assert!(apple_ease_out(0.0) <= 0.01);
        assert!(apple_ease_out(0.5) > 0.75);
        assert!((apple_ease_out(1.0) - 1.0).abs() < 0.01);
        assert_eq!(lerp_px(0.0, 40.0, 0.5), px(20.0));
    }
}
