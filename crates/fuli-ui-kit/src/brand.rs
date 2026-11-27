//! Official FULI Brand Assets, Optical Logo Marks, Wordmarks, Icons & Compounding Loading Motion.
//! Single source of truth: workspace `brand/` (Brand & Motion Guidelines v1.1).

use std::borrow::Cow;
use std::f32::consts::PI;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, AssetSource, ElementId, Hsla, Image, ImageFormat,
    IntoElement, ParentElement, PathBuilder, Pixels, Point, Result, SharedString, Styled, Window,
    canvas, div, img, linear_color_stop, linear_gradient, point, px, rgb, rgba, svg,
};

use crate::tokens::{colors, layout, typography};

// Embedded directly from `brand/` so binaries work cleanly from any working directory on Win & Mac.
const MARK_COLOR_PNG: &[u8] = include_bytes!("../../../brand/png/mark/fuli-mark-color-512.png");
const APP_ICON_PNG: &[u8] =
    include_bytes!("../../../brand/png/app-icon/fuli-app-icon-light-512.png");
const WORDMARK_EN_SVG: &[u8] = include_bytes!("../../../brand/svg/wordmark/fuli-wordmark-en.svg");
const WORDMARK_ZH_SVG: &[u8] = include_bytes!("../../../brand/svg/wordmark/fuli-wordmark-zh.svg");

const BRAND_INK_HEX: u32 = 0x18181b;
const BRAND_GOLD_START_HEX: u32 = 0xdc9a30;
const BRAND_GOLD_MID_HEX: u32 = 0xb87b20;

/// Combined GPUI `AssetSource`: serves embedded FULI brand SVGs plus the full bundled Lucide icon set.
#[derive(Clone, Copy, Debug, Default)]
pub struct FuliAssets;

impl AssetSource for FuliAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        match path {
            "brand/fuli-wordmark-en.svg" => Ok(Some(Cow::Borrowed(WORDMARK_EN_SVG))),
            "brand/fuli-wordmark-zh.svg" => Ok(Some(Cow::Borrowed(WORDMARK_ZH_SVG))),
            _ => gpui_kit::assets::AllAssets.load(path),
        }
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        let mut items = gpui_kit::assets::AllAssets.list(path).unwrap_or_default();
        for name in ["brand/fuli-wordmark-en.svg", "brand/fuli-wordmark-zh.svg"] {
            if name.starts_with(path) {
                items.push(name.into());
            }
        }
        Ok(items)
    }
}

fn mark_png_image() -> Arc<Image> {
    static CACHE: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(
        CACHE
            .get_or_init(|| Arc::new(Image::from_bytes(ImageFormat::Png, MARK_COLOR_PNG.to_vec()))),
    )
}

fn app_icon_png_image() -> Arc<Image> {
    static CACHE: OnceLock<Arc<Image>> = OnceLock::new();
    Arc::clone(
        CACHE.get_or_init(|| Arc::new(Image::from_bytes(ImageFormat::Png, APP_ICON_PNG.to_vec()))),
    )
}

/// Crisp vector Lucide outline icon from `FuliAssets` (`icon_name` e.g. `"sun"`, `"layers"`, `"settings"`).
pub fn fuli_icon(icon_name: &str, size_px: f32, color: impl Into<Hsla>) -> AnyElement {
    svg()
        .path(format!("icons/{icon_name}.svg"))
        .size(px(size_px))
        .flex_shrink_0()
        .text_color(color.into())
        .into_any_element()
}

/// Official full-color FULI Brand Logomark (black-gold orbital arc + wave + 3 compounding bars).
pub fn fuli_logo_mark(size_px: f32) -> AnyElement {
    img(mark_png_image())
        .size(px(size_px))
        .flex_shrink_0()
        .into_any_element()
}

/// Official light rounded-square FULI App Icon plate (22.5% corner radius per Brand Guidelines v1.1).
pub fn fuli_app_icon(size_px: f32) -> AnyElement {
    let radius = (size_px * 0.225).round();
    div()
        .size(px(size_px))
        .rounded(px(radius))
        .overflow_hidden()
        .border_1()
        .border_color(colors::border())
        .flex_shrink_0()
        .child(img(app_icon_png_image()).size(px(size_px)))
        .into_any_element()
}

/// Official bespoke geometric FULI English vector wordmark (`782 × 236` aspect ratio) in brand ink `#18181B`.
pub fn fuli_wordmark_en(height_px: f32) -> AnyElement {
    let width_px = height_px * (782.0 / 236.0);
    svg()
        .path("brand/fuli-wordmark-en.svg")
        .w(px(width_px))
        .h(px(height_px))
        .flex_shrink_0()
        .text_color(rgb(BRAND_INK_HEX))
        .into_any_element()
}

/// Official 复利 Chinese vector wordmark (`452 × 232` aspect ratio) in brand ink `#18181B`.
pub fn fuli_wordmark_zh(height_px: f32) -> AnyElement {
    let width_px = height_px * (452.0 / 232.0);
    svg()
        .path("brand/fuli-wordmark-zh.svg")
        .w(px(width_px))
        .h(px(height_px))
        .flex_shrink_0()
        .text_color(rgb(BRAND_INK_HEX))
        .into_any_element()
}

/// Top-left application brand lockup: official Logomark + `FULI` vector wordmark + live connection dot + version.
pub fn fuli_brand_lockup(version: impl Into<SharedString>, connected: bool) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(fuli_logo_mark(26.0))
        .child(fuli_wordmark_en(17.0))
        .child(
            div()
                .size(px(7.0))
                .rounded(layout::radius_pill())
                .bg(if connected {
                    colors::success()
                } else {
                    colors::warning()
                }),
        )
        .child(
            div()
                .text_size(typography::meta_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::muted())
                .child(version.into()),
        )
        .into_any_element()
}

/// Official Compounding Loading scale tiers (`brand/motion/fuli-motion.css`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadingSize {
    /// 16px inline indicator — uses micro optical cut (`< 28px`).
    Inline,
    /// 28px compact card/banner indicator — uses master cut (`>= 28px`).
    Compact,
    /// 48px full-page / hero loading indicator — uses master cut.
    Page,
}

impl LoadingSize {
    pub fn px(self) -> f32 {
        match self {
            Self::Inline => 16.0,
            Self::Compact => 28.0,
            Self::Page => 48.0,
        }
    }

    pub fn uses_micro_cut(self) -> bool {
        self.px() < 28.0
    }
}

/// Pure animated 6-layer FULI Brand Compounding Loading mark.
/// Follows `brand/motion/fuli-motion.css` (2.2s cycle, staggered bar growth `0ms / 170ms / 340ms`,
/// pulsing gold orbit, optical micro cut below 28px, and automatic `App::reduce_motion` support).
pub fn fuli_loading_mark(id: impl Into<ElementId>, size: LoadingSize) -> AnyElement {
    let dim = size.px();
    let micro = size.uses_micro_cut();
    let elem_id = id.into();

    div()
        .size(px(dim))
        .flex_shrink_0()
        .with_animation(
            elem_id,
            Animation::new(Duration::from_millis(2200)).repeat_synced(),
            move |container, phase| {
                container.child(
                    canvas(
                        move |_, _, _| phase,
                        move |bounds, t, window, _| {
                            paint_fuli_mark_frame(bounds, dim, micro, t, window);
                        },
                    )
                    .size(px(dim)),
                )
            },
        )
        .into_any_element()
}

/// Brand Compounding Loading bar with official animated mark + concise plain-language label.
pub fn fuli_loading(
    id: impl Into<ElementId>,
    size: LoadingSize,
    label: impl Into<SharedString>,
) -> AnyElement {
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
        .child(fuli_loading_mark(id, size))
        .child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::ink())
                .child(label.into()),
        )
        .into_any_element()
}

// ============================================================================
// Exact 6-Layer Brand Mark Canvas Painter (512×512 viewBox -> GPUI PathBuilder)
// ============================================================================

/// Smooth ease curve matching `fuli-load-bar` (`0..0.12` low, `0.46..0.58` peak, `1.0` low).
fn bar_phase_curve(t: f32, delay_fraction: f32) -> (f32, f32) {
    let p = (t - delay_fraction).rem_euclid(1.0);
    let wave = if p < 0.12 {
        0.0
    } else if p < 0.46 {
        let u = (p - 0.12) / 0.34;
        0.5 - 0.5 * (u * PI).cos()
    } else if p < 0.58 {
        1.0
    } else {
        let u = (p - 0.58) / 0.42;
        0.5 + 0.5 * (u * PI).cos()
    };
    let scale_y = 0.38 + 0.62 * wave;
    let opacity = 0.28 + 0.72 * wave;
    (scale_y, opacity)
}

fn pulse_curve(t: f32, peak_at: f32) -> f32 {
    let p = t.rem_euclid(1.0);
    if p <= peak_at {
        let u = p / peak_at.max(0.01);
        0.5 - 0.5 * (u * PI).cos()
    } else {
        let u = (p - peak_at) / (1.0 - peak_at).max(0.01);
        0.5 + 0.5 * (u * PI).cos()
    }
}

fn pt(ox: Pixels, oy: Pixels, s: f32, x: f32, y: f32) -> Point<Pixels> {
    point(ox + px(x * s), oy + px(y * s))
}

fn pt_rot(ox: Pixels, oy: Pixels, s: f32, x: f32, y: f32, deg: f32) -> Point<Pixels> {
    let rad = deg.to_radians();
    let dx = x - 256.0;
    let dy = y - 256.0;
    let rx = 256.0 + dx * rad.cos() - dy * rad.sin();
    let ry = 256.0 + dx * rad.sin() + dy * rad.cos();
    pt(ox, oy, s, rx, ry)
}

fn pt_bar(ox: Pixels, oy: Pixels, s: f32, x: f32, y: f32, anchor_y: f32, sy: f32) -> Point<Pixels> {
    let scaled_y = anchor_y + (y - anchor_y) * sy;
    pt(ox, oy, s, x, scaled_y)
}

fn paint_fuli_mark_frame(
    bounds: gpui_kit::Bounds<Pixels>,
    dim: f32,
    micro: bool,
    t: f32,
    window: &mut Window,
) {
    let ox = bounds.origin.x;
    let oy = bounds.origin.y;
    let s = dim / 512.0;

    let gold_pulse = pulse_curve(t, 0.42);
    let upper_pulse = pulse_curve(t, 0.48);
    let wave_pulse = pulse_curve(t, 0.45);

    let gold_alpha = 0.52 + 0.48 * gold_pulse;
    let gold_deg = 4.0 * (1.0 - gold_pulse);
    let upper_alpha = 0.34 + 0.58 * upper_pulse;
    let upper_deg = -4.0 * (1.0 - upper_pulse);
    let wave_alpha = 0.45 + 0.55 * wave_pulse;

    // 1. Lower Black-Gold Orbit (`fuli-orbit-gold`)
    {
        let mut b = PathBuilder::fill();
        if micro {
            b.move_to(pt_rot(ox, oy, s, 28.20, 300.70, gold_deg));
            b.line_to(pt_rot(ox, oy, s, 52.00, 292.60, gold_deg));
            b.arc_to(
                point(px(4.0 * s), px(4.0 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 56.40, 295.40, gold_deg),
            );
            b.arc_to(
                point(px(202.0 * s), px(202.0 * s)),
                px(gold_deg),
                false,
                false,
                pt_rot(ox, oy, s, 400.38, 382.10, gold_deg),
            );
            b.line_to(pt_rot(ox, oy, s, 454.50, 383.80, gold_deg));
            b.arc_to(
                point(px(236.0 * s), px(236.0 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 25.10, 305.50, gold_deg),
            );
            b.arc_to(
                point(px(4.0 * s), px(4.0 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 28.20, 300.70, gold_deg),
            );
        } else {
            b.move_to(pt_rot(ox, oy, s, 38.52, 293.02, gold_deg));
            b.line_to(pt_rot(ox, oy, s, 55.05, 287.21, gold_deg));
            b.arc_to(
                point(px(3.2 * s), px(3.2 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 58.56, 289.25, gold_deg),
            );
            b.arc_to(
                point(px(198.0 * s), px(198.0 * s)),
                px(gold_deg),
                false,
                false,
                pt_rot(ox, oy, s, 400.98, 377.42, gold_deg),
            );
            b.line_to(pt_rot(ox, oy, s, 444.63, 376.80, gold_deg));
            b.arc_to(
                point(px(224.0 * s), px(224.0 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 35.89, 297.59, gold_deg),
            );
            b.arc_to(
                point(px(3.2 * s), px(3.2 * s)),
                px(gold_deg),
                false,
                true,
                pt_rot(ox, oy, s, 38.52, 293.02, gold_deg),
            );
        }
        b.close();
        if let Ok(path) = b.build() {
            let gold_bg = linear_gradient(
                135.0,
                linear_color_stop(
                    Hsla::from(rgb(BRAND_GOLD_START_HEX)).opacity(gold_alpha),
                    0.0,
                ),
                linear_color_stop(
                    Hsla::from(rgb(BRAND_GOLD_MID_HEX)).opacity(gold_alpha * 0.85),
                    1.0,
                ),
            );
            window.paint_path(path, gold_bg);
        }
    }

    // 2. Upper Ink Orbit (`fuli-orbit-upper`)
    {
        let mut b = PathBuilder::fill();
        if micro {
            b.move_to(pt_rot(ox, oy, s, 60.22, 246.00, upper_deg));
            b.arc_to(
                point(px(237.0 * s), px(237.0 * s)),
                px(upper_deg),
                false,
                true,
                pt_rot(ox, oy, s, 286.00, 33.21, upper_deg),
            );
            b.arc_to(
                point(px(5.64 * s), px(5.64 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 286.00, 21.92, upper_deg),
            );
            b.arc_to(
                point(px(236.0 * s), px(236.0 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 20.54, 272.00, upper_deg),
            );
            b.arc_to(
                point(px(4.0 * s), px(4.0 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 25.20, 275.20, upper_deg),
            );
            b.line_to(pt_rot(ox, oy, s, 61.00, 264.50, upper_deg));
            b.line_to(pt_rot(ox, oy, s, 60.22, 246.00, upper_deg));
        } else {
            b.move_to(pt_rot(ox, oy, s, 62.31, 248.00, upper_deg));
            b.arc_to(
                point(px(228.4 * s), px(228.4 * s)),
                px(upper_deg),
                false,
                true,
                pt_rot(ox, oy, s, 285.20, 37.65, upper_deg),
            );
            b.arc_to(
                point(px(1.87 * s), px(1.87 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 285.24, 33.92, upper_deg),
            );
            b.arc_to(
                point(px(224.0 * s), px(224.0 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 32.54, 271.50, upper_deg),
            );
            b.arc_to(
                point(px(3.2 * s), px(3.2 * s)),
                px(upper_deg),
                false,
                false,
                pt_rot(ox, oy, s, 36.10, 274.00, upper_deg),
            );
            b.line_to(pt_rot(ox, oy, s, 62.50, 264.70, upper_deg));
            b.line_to(pt_rot(ox, oy, s, 62.31, 248.00, upper_deg));
        }
        b.close();
        if let Ok(path) = b.build() {
            window.paint_path(path, Hsla::from(rgb(BRAND_INK_HEX)).opacity(upper_alpha));
        }
    }

    // 3. Compounding Wave (`fuli-wave`)
    {
        let mut b = PathBuilder::fill();
        if micro {
            b.move_to(pt(ox, oy, s, 55.00, 248.00));
            b.line_to(pt(ox, oy, s, 60.22, 246.00));
            b.cubic_bezier_to(
                pt(ox, oy, s, 200.00, 266.00),
                pt(ox, oy, s, 104.00, 222.00),
                pt(ox, oy, s, 156.00, 233.00),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 356.00, 356.00),
                pt(ox, oy, s, 248.00, 302.00),
                pt(ox, oy, s, 300.00, 356.00),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 486.20, 236.00),
                pt(ox, oy, s, 416.00, 356.00),
                pt(ox, oy, s, 468.00, 316.00),
            );
            b.arc_to(
                point(px(2.48 * s), px(2.48 * s)),
                px(0.0),
                false,
                true,
                pt(ox, oy, s, 491.15, 236.00),
            );
            b.arc_to(
                point(px(236.0 * s), px(236.0 * s)),
                px(0.0),
                false,
                true,
                pt(ox, oy, s, 448.00, 393.10),
            );
            b.line_to(pt(ox, oy, s, 400.38, 382.10));
            b.cubic_bezier_to(
                pt(ox, oy, s, 354.00, 388.00),
                pt(ox, oy, s, 388.00, 385.50),
                pt(ox, oy, s, 372.00, 388.00),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 188.00, 298.00),
                pt(ox, oy, s, 294.00, 388.00),
                pt(ox, oy, s, 232.00, 332.00),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 61.00, 264.50),
                pt(ox, oy, s, 148.00, 267.30),
                pt(ox, oy, s, 103.00, 252.00),
            );
            b.line_to(pt(ox, oy, s, 55.00, 266.30));
        } else {
            b.move_to(pt(ox, oy, s, 58.00, 249.80));
            b.line_to(pt(ox, oy, s, 62.31, 248.00));
            b.cubic_bezier_to(
                pt(ox, oy, s, 204.00, 266.00),
                pt(ox, oy, s, 106.00, 224.00),
                pt(ox, oy, s, 159.00, 234.50),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 362.00, 351.50),
                pt(ox, oy, s, 254.00, 301.00),
                pt(ox, oy, s, 306.00, 351.50),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 476.00, 239.40),
                pt(ox, oy, s, 419.00, 351.50),
                pt(ox, oy, s, 462.50, 313.00),
            );
            b.arc_to(
                point(px(1.7 * s), px(1.7 * s)),
                px(0.0),
                false,
                true,
                pt(ox, oy, s, 479.40, 239.59),
            );
            b.arc_to(
                point(px(224.0 * s), px(224.0 * s)),
                px(0.0),
                false,
                true,
                pt(ox, oy, s, 438.03, 386.60),
            );
            b.line_to(pt(ox, oy, s, 400.98, 377.42));
            b.cubic_bezier_to(
                pt(ox, oy, s, 358.00, 378.60),
                pt(ox, oy, s, 390.00, 378.30),
                pt(ox, oy, s, 376.00, 378.60),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 192.00, 294.50),
                pt(ox, oy, s, 298.00, 378.60),
                pt(ox, oy, s, 237.00, 326.90),
            );
            b.cubic_bezier_to(
                pt(ox, oy, s, 62.50, 264.70),
                pt(ox, oy, s, 152.00, 265.70),
                pt(ox, oy, s, 106.00, 249.36),
            );
            b.line_to(pt(ox, oy, s, 58.00, 266.29));
        }
        b.close();
        if let Ok(path) = b.build() {
            window.paint_path(path, Hsla::from(rgb(BRAND_INK_HEX)).opacity(wave_alpha));
        }
    }

    // 4-6. Staggered Ascending Compounding Bars (`0ms`, `170ms`, `340ms` / `2200ms`)
    let bar_specs: [(f32, f32, f32, f32, f32, f32); 3] = if micro {
        [
            (272.0, 214.0, 312.0, 314.0, 314.0, 0.0),
            (336.0, 152.0, 376.0, 330.0, 330.0, 170.0 / 2200.0),
            (400.0, 88.0, 440.0, 316.0, 316.0, 340.0 / 2200.0),
        ]
    } else {
        [
            (294.0, 224.0, 330.0, 324.0, 324.0, 0.0),
            (348.0, 166.0, 384.0, 334.0, 334.0, 170.0 / 2200.0),
            (402.0, 96.0, 438.0, 316.0, 316.0, 340.0 / 2200.0),
        ]
    };

    for (x1, y1, x2, y2, anchor_y, delay) in bar_specs {
        let (sy, alpha) = bar_phase_curve(t, delay);
        let r = if micro { 7.2 } else { 5.6 };
        let mut b = PathBuilder::fill();
        b.move_to(pt_bar(ox, oy, s, x1, y1 + r, anchor_y, sy));
        b.arc_to(
            point(px(r * s), px(r * s * sy)),
            px(0.0),
            false,
            true,
            pt_bar(ox, oy, s, x1 + r, y1, anchor_y, sy),
        );
        b.line_to(pt_bar(ox, oy, s, x2 - r, y1, anchor_y, sy));
        b.arc_to(
            point(px(r * s), px(r * s * sy)),
            px(0.0),
            false,
            true,
            pt_bar(ox, oy, s, x2, y1 + r, anchor_y, sy),
        );
        b.line_to(pt_bar(ox, oy, s, x2, y2 - 4.0, anchor_y, sy));
        b.line_to(pt_bar(ox, oy, s, x1, y2 - 8.0, anchor_y, sy));
        b.close();
        if let Ok(path) = b.build() {
            let color = if delay > 0.14 {
                Hsla::from(rgba(0x18181bff)).opacity(alpha)
            } else {
                Hsla::from(rgb(BRAND_INK_HEX)).opacity(alpha)
            };
            window.paint_path(path, color);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brand_assets_and_optical_cuts_match_guidelines() {
        assert!(
            FuliAssets
                .load("brand/fuli-wordmark-en.svg")
                .unwrap()
                .is_some()
        );
        assert!(
            FuliAssets
                .load("brand/fuli-wordmark-zh.svg")
                .unwrap()
                .is_some()
        );
        assert!(FuliAssets.load("icons/sun.svg").unwrap().is_some());
        assert!(FuliAssets.load("icons/network.svg").unwrap().is_some());

        assert!(LoadingSize::Inline.uses_micro_cut());
        assert!(!LoadingSize::Compact.uses_micro_cut());
        assert!(!LoadingSize::Page.uses_micro_cut());

        let (sy_start, op_start) = bar_phase_curve(0.0, 0.0);
        let (sy_peak, op_peak) = bar_phase_curve(0.50, 0.0);
        assert!(sy_start < 0.45 && op_start < 0.35);
        assert!(sy_peak > 0.98 && op_peak > 0.98);
    }
}
