//! Living FULI Concierge Orb ("FULI 大管家" 流体光球) — Apple / Codex-Dot inspired native GPUI motion.
//!
//! Pure hardware-accelerated 60fps `canvas` + `Animation::repeat_synced()` rendering in the official
//! FULI obsidian-ink (`#18181B`) and warm-gold (`#DC9A30` / `#B38A4C`) palette, automatically
//! respecting OS `prefers-reduced-motion`.

use std::f32::consts::{PI, TAU};
use std::time::Duration;

use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, Bounds, ElementId, Hsla, IntoElement, ParentElement,
    PathBuilder, Pixels, Point, Styled, Window, canvas, div, linear_color_stop, linear_gradient,
    point, px, rgb,
};

const INK_CORE_HEX: u32 = 0x18181b;
const INK_DEEP_HEX: u32 = 0x27272a;
const GOLD_BRIGHT_HEX: u32 = 0xe5a93c;
const GOLD_MID_HEX: u32 = 0xc68b2c;
const GOLD_WARM_HEX: u32 = 0xb38a4c;
const EMERALD_HEX: u32 = 0x1f8a5b;
const SPECULAR_HEX: u32 = 0xfefcf8;

/// Emotional & operational motion state of the FULI Concierge Living Orb.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrbState {
    /// Calm harmonic breathing with a slow single gold satellite orbit.
    Idle,
    /// Analytical counter-rotating orbital arcs while routing intent across FULI Bots.
    Routing,
    /// Vibrant compounding dual-orbit flow with soft expanding ripples while tasks run live.
    Running,
    /// Gentle warm-gold double beacon pulse when a route preview or inbox needs confirmation.
    Attention,
}

impl OrbState {
    pub fn cycle_duration(self) -> Duration {
        match self {
            Self::Idle => Duration::from_millis(3800),
            Self::Routing => Duration::from_millis(1750),
            Self::Running => Duration::from_millis(1350),
            Self::Attention => Duration::from_millis(2400),
        }
    }
}

/// Hero animated Living Orb for the FULI Concierge ("FULI 大管家").
pub fn fuli_concierge_orb(id: impl Into<ElementId>, state: OrbState, size_px: f32) -> AnyElement {
    let dim = size_px.max(24.0);
    let elem_id = id.into();
    let duration = state.cycle_duration();

    div()
        .size(px(dim))
        .flex_shrink_0()
        .with_animation(
            elem_id,
            Animation::new(duration).repeat_synced(),
            move |container, phase| {
                container.child(
                    canvas(
                        move |_, _, _| phase,
                        move |bounds, t, window, _| {
                            paint_living_orb(bounds, state, t, window);
                        },
                    )
                    .size(px(dim)),
                )
            },
        )
        .into_any_element()
}

/// Compact 14px animated orb dot used inside active Running Task cards & top-bar live pills.
pub fn orb_mini_indicator(id: impl Into<ElementId>, running: bool) -> AnyElement {
    let elem_id = id.into();
    let dur = if running {
        Duration::from_millis(1200)
    } else {
        Duration::from_millis(3200)
    };
    div()
        .size(px(14.0))
        .flex_shrink_0()
        .with_animation(
            elem_id,
            Animation::new(dur).repeat_synced(),
            move |container, phase| {
                container.child(
                    canvas(
                        move |_, _, _| phase,
                        move |bounds, t, window, _| {
                            paint_mini_orb(bounds, running, t, window);
                        },
                    )
                    .size(px(14.0)),
                )
            },
        )
        .into_any_element()
}

fn paint_mini_orb(bounds: Bounds<Pixels>, running: bool, t: f32, window: &mut Window) {
    let cx = f32::from(bounds.origin.x) + f32::from(bounds.size.width) * 0.5;
    let cy = f32::from(bounds.origin.y) + f32::from(bounds.size.height) * 0.5;
    let wave = 0.5 - 0.5 * (t * TAU).cos();

    if running {
        let ripple_r = 3.5 + 3.4 * t;
        let ripple_alpha = (1.0 - t) * 0.45;
        paint_ring_stroke(
            cx,
            cy,
            ripple_r,
            1.2,
            Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(ripple_alpha),
            window,
        );
        paint_circle_fill(
            cx,
            cy,
            3.3 + 0.6 * wave,
            Hsla::from(rgb(GOLD_MID_HEX)),
            window,
        );
        let sat_a = t * TAU;
        paint_circle_fill(
            cx + 5.3 * sat_a.cos(),
            cy + 5.3 * sat_a.sin(),
            1.2,
            Hsla::from(rgb(INK_CORE_HEX)).opacity(0.85),
            window,
        );
    } else {
        paint_circle_fill(
            cx,
            cy,
            4.2 + 0.5 * wave,
            Hsla::from(rgb(EMERALD_HEX)).opacity(0.16),
            window,
        );
        paint_circle_fill(cx, cy, 2.8, Hsla::from(rgb(EMERALD_HEX)), window);
    }
}

fn paint_living_orb(bounds: Bounds<Pixels>, state: OrbState, t: f32, window: &mut Window) {
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let w = f32::from(bounds.size.width);
    let h = f32::from(bounds.size.height);
    let cx = ox + w * 0.5;
    let cy = oy + h * 0.5;
    let unit = w.min(h) * 0.5;

    let breath = 0.5 - 0.5 * (t * TAU).cos();
    let core_r = match state {
        OrbState::Idle => unit * (0.44 + 0.03 * breath),
        OrbState::Routing => unit * (0.43 + 0.045 * breath),
        OrbState::Running => unit * (0.42 + 0.055 * breath),
        OrbState::Attention => unit * (0.44 + 0.04 * breath),
    };

    // 1. Soft atmospheric ambient aura layers (warm gold tint, ultra-clean on `#F7F7F5`)
    let aura_alpha = match state {
        OrbState::Idle => 0.08 + 0.05 * breath,
        OrbState::Routing => 0.12 + 0.08 * breath,
        OrbState::Running => 0.16 + 0.10 * breath,
        OrbState::Attention => 0.14 + 0.09 * breath,
    };
    paint_circle_fill(
        cx,
        cy,
        unit * (0.88 + 0.06 * breath),
        Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(aura_alpha * 0.45),
        window,
    );
    paint_circle_fill(
        cx,
        cy,
        unit * (0.68 + 0.05 * breath),
        Hsla::from(rgb(GOLD_MID_HEX)).opacity(aura_alpha),
        window,
    );

    // 2. State-specific dynamic ripple rings
    match state {
        OrbState::Running => {
            for offset in [0.0_f32, 0.5_f32] {
                let p = (t + offset).rem_euclid(1.0);
                let r = core_r + (unit * 0.54) * p;
                let a = (1.0 - p).powf(1.5) * 0.42;
                paint_ring_stroke(
                    cx,
                    cy,
                    r,
                    1.3,
                    Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(a),
                    window,
                );
            }
        }
        OrbState::Attention => {
            let p = t.rem_euclid(1.0);
            let r = core_r + (unit * 0.46) * p;
            let a = (1.0 - p) * 0.48;
            paint_ring_stroke(
                cx,
                cy,
                r,
                1.5,
                Hsla::from(rgb(GOLD_MID_HEX)).opacity(a),
                window,
            );
        }
        OrbState::Routing => {
            paint_ring_stroke(
                cx,
                cy,
                unit * 0.78,
                1.1,
                Hsla::from(rgb(GOLD_WARM_HEX)).opacity(0.24 + 0.14 * breath),
                window,
            );
        }
        OrbState::Idle => {
            paint_ring_stroke(
                cx,
                cy,
                unit * 0.74,
                1.0,
                Hsla::from(rgb(INK_CORE_HEX)).opacity(0.08 + 0.04 * breath),
                window,
            );
        }
    }

    // 3. Back half of tilted elliptical orbits (drawn behind core sphere)
    let tilt1 = -0.36_f32;
    let tilt2 = 0.42_f32;
    let rx = unit * 0.84;
    let ry = unit * 0.34;

    match state {
        OrbState::Idle => {
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx,
                ry,
                tilt1,
                PI,
                PI,
                1.15,
                Hsla::from(rgb(GOLD_WARM_HEX)).opacity(0.26),
                window,
            );
        }
        OrbState::Routing => {
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx,
                ry,
                tilt1,
                t * TAU,
                PI * 1.15,
                1.35,
                Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(0.45),
                window,
            );
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx * 0.92,
                ry * 0.92,
                tilt2,
                -t * TAU + PI,
                PI * 0.95,
                1.15,
                Hsla::from(rgb(INK_CORE_HEX)).opacity(0.25),
                window,
            );
        }
        OrbState::Running => {
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx,
                ry,
                tilt1,
                0.0,
                TAU,
                1.3,
                Hsla::from(rgb(GOLD_MID_HEX)).opacity(0.32),
                window,
            );
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx * 0.95,
                ry * 0.95,
                tilt2,
                0.0,
                TAU,
                1.1,
                Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(0.26),
                window,
            );
        }
        OrbState::Attention => {
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx * 0.92,
                ry * 0.92,
                tilt1,
                0.0,
                TAU,
                1.35,
                Hsla::from(rgb(GOLD_MID_HEX)).opacity(0.36 + 0.18 * breath),
                window,
            );
        }
    }

    // 4. Core Obsidian-Gold Sphere (Apple jewel-like gradient depth + soft specular crescent)
    let core_bg = match state {
        OrbState::Running => linear_gradient(
            135.0,
            linear_color_stop(Hsla::from(rgb(INK_CORE_HEX)), 0.0),
            linear_color_stop(Hsla::from(rgb(GOLD_MID_HEX)), 1.0),
        ),
        OrbState::Attention => linear_gradient(
            135.0,
            linear_color_stop(Hsla::from(rgb(INK_DEEP_HEX)), 0.0),
            linear_color_stop(Hsla::from(rgb(GOLD_WARM_HEX)), 1.0),
        ),
        OrbState::Idle | OrbState::Routing => linear_gradient(
            135.0,
            linear_color_stop(Hsla::from(rgb(INK_DEEP_HEX)), 0.0),
            linear_color_stop(Hsla::from(rgb(INK_CORE_HEX)), 1.0),
        ),
    };
    paint_circle_fill_bg(cx, cy, core_r, core_bg, window);

    // Subtle warm-gold inner rim on the lower-right edge of the core sphere
    paint_ring_stroke(
        cx,
        cy,
        core_r - 0.8,
        1.25,
        Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(match state {
            OrbState::Running => 0.72,
            OrbState::Attention => 0.62,
            OrbState::Routing => 0.48,
            OrbState::Idle => 0.34 + 0.14 * breath,
        }),
        window,
    );

    // Delicate top-left pearl specular highlight (gives tactile glass-obsidian feel)
    paint_circle_fill(
        cx - core_r * 0.30,
        cy - core_r * 0.32,
        core_r * 0.24,
        Hsla::from(rgb(SPECULAR_HEX)).opacity(0.18 + 0.08 * breath),
        window,
    );

    // Mini inner compounding core spark (golden heartbeat dot at center)
    let spark_r = match state {
        OrbState::Running => core_r * (0.22 + 0.08 * breath),
        OrbState::Routing => core_r * (0.18 + 0.06 * breath),
        OrbState::Attention => core_r * (0.20 + 0.06 * breath),
        OrbState::Idle => core_r * (0.14 + 0.04 * breath),
    };
    paint_circle_fill(
        cx,
        cy,
        spark_r,
        Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(0.85),
        window,
    );

    // 5. Front orbital arc & luminous gliding satellites
    match state {
        OrbState::Idle => {
            paint_tilted_orbit_arc(
                cx,
                cy,
                rx,
                ry,
                tilt1,
                0.0,
                PI,
                1.35,
                Hsla::from(rgb(GOLD_MID_HEX)).opacity(0.45),
                window,
            );
            let a = t * TAU;
            let (sx, sy) = ellipse_point(cx, cy, rx, ry, tilt1, a);
            paint_circle_fill(
                sx,
                sy,
                (unit * 0.105).max(2.6),
                Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(0.95),
                window,
            );
        }
        OrbState::Routing => {
            for i in 0..3 {
                let a = t * TAU + (i as f32) * (TAU / 3.0);
                let (sx, sy) = ellipse_point(cx, cy, rx, ry, tilt1, a);
                paint_circle_fill(
                    sx,
                    sy,
                    (unit * 0.095).max(2.4),
                    Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(0.92),
                    window,
                );
            }
        }
        OrbState::Running => {
            // 3 energetic golden sparks with smooth trailing pearls across dual orbits
            for i in 0..3 {
                let orbit_tilt = if i % 2 == 0 { tilt1 } else { tilt2 };
                let dir = if i % 2 == 0 { 1.0 } else { -1.0 };
                let head = dir * (t * TAU) + (i as f32) * (TAU / 3.0);
                for trail in [0.24_f32, 0.12_f32, 0.0_f32] {
                    let a = head - dir * trail;
                    let (sx, sy) = ellipse_point(cx, cy, rx, ry, orbit_tilt, a);
                    let r = if trail == 0.0 {
                        (unit * 0.11).max(2.8)
                    } else {
                        (unit * 0.075).max(1.8)
                    };
                    let op = if trail == 0.0 {
                        0.98
                    } else if trail < 0.2 {
                        0.50
                    } else {
                        0.22
                    };
                    paint_circle_fill(
                        sx,
                        sy,
                        r,
                        Hsla::from(rgb(GOLD_BRIGHT_HEX)).opacity(op),
                        window,
                    );
                }
            }
        }
        OrbState::Attention => {
            let a = t * TAU;
            let (sx, sy) = ellipse_point(cx, cy, rx * 0.92, ry * 0.92, tilt1, a);
            paint_circle_fill(
                sx,
                sy,
                (unit * 0.115).max(2.8),
                Hsla::from(rgb(GOLD_BRIGHT_HEX)),
                window,
            );
        }
    }
}

#[inline]
fn ellipse_point(cx: f32, cy: f32, rx: f32, ry: f32, tilt: f32, angle: f32) -> (f32, f32) {
    let lx = rx * angle.cos();
    let ly = ry * angle.sin();
    let cos_t = tilt.cos();
    let sin_t = tilt.sin();
    (cx + lx * cos_t - ly * sin_t, cy + lx * sin_t + ly * cos_t)
}

fn paint_circle_fill(cx: f32, cy: f32, r: f32, color: Hsla, window: &mut Window) {
    paint_circle_fill_bg(cx, cy, r, color, window);
}

fn paint_circle_fill_bg(
    cx: f32,
    cy: f32,
    r: f32,
    bg: impl Into<gpui_kit::Background>,
    window: &mut Window,
) {
    if r <= 0.2 {
        return;
    }
    const SEGMENTS: usize = 36;
    let mut b = PathBuilder::fill();
    for i in 0..SEGMENTS {
        let a = (i as f32 / SEGMENTS as f32) * TAU;
        let p: Point<Pixels> = point(px(cx + r * a.cos()), px(cy + r * a.sin()));
        if i == 0 {
            b.move_to(p);
        } else {
            b.line_to(p);
        }
    }
    b.close();
    if let Ok(path) = b.build() {
        window.paint_path(path, bg);
    }
}

fn paint_ring_stroke(cx: f32, cy: f32, r: f32, width: f32, color: Hsla, window: &mut Window) {
    if r <= 0.5 || color.a <= 0.005 {
        return;
    }
    const SEGMENTS: usize = 44;
    let mut b = PathBuilder::stroke(px(width));
    for i in 0..=SEGMENTS {
        let a = (i as f32 / SEGMENTS as f32) * TAU;
        let p: Point<Pixels> = point(px(cx + r * a.cos()), px(cy + r * a.sin()));
        if i == 0 {
            b.move_to(p);
        } else {
            b.line_to(p);
        }
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_tilted_orbit_arc(
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    tilt: f32,
    start_rad: f32,
    sweep_rad: f32,
    width: f32,
    color: Hsla,
    window: &mut Window,
) {
    if rx <= 1.0 || color.a <= 0.005 {
        return;
    }
    const STEPS: usize = 36;
    let mut b = PathBuilder::stroke(px(width));
    for i in 0..=STEPS {
        let a = start_rad + sweep_rad * (i as f32 / STEPS as f32);
        let (x, y) = ellipse_point(cx, cy, rx, ry, tilt, a);
        let p = point(px(x), px(y));
        if i == 0 {
            b.move_to(p);
        } else {
            b.line_to(p);
        }
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orb_states_have_distinct_cycle_durations_and_valid_geometry() {
        assert!(OrbState::Running.cycle_duration() < OrbState::Idle.cycle_duration());
        assert!(OrbState::Routing.cycle_duration() < OrbState::Attention.cycle_duration());
        let (x, y) = ellipse_point(50.0, 50.0, 30.0, 12.0, 0.0, 0.0);
        assert!((x - 80.0).abs() < 0.01);
        assert!((y - 50.0).abs() < 0.01);
    }
}
