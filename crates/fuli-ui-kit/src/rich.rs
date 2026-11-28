//! Rich interactive primitives with silky spring motion:
//! hover tooltip, FLA hover card, switch, checkbox, breadcrumb, dialog (+ content
//! building blocks) and progress bars. Every animation goes through `FuliSpring`
//! presets / `with_spring`, which honour the OS reduce-motion setting.

use std::f32::consts::PI;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, AnyView, App, AppContext as _, Bounds, BoxShadow,
    Context, Div, ElementId, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement,
    PathBuilder, Pixels, Render, Rgba, SharedString, SpringAnimation, Stateful,
    StatefulInteractiveElement, Styled, Window, canvas, div, hsla, point, px, relative,
};

use crate::brand::fuli_icon;
use crate::layout_kit::{AvatarPresence, AvatarSize, fuli_avatar};
use crate::motion::{FuliSpring, apple_ease_out, spring_entrance};
use crate::primitives::{BadgeTone, divider, ghost_button};
use crate::tokens::{ControlSize, colors, layout, typography};

// ============================================================================
// Shared helpers
// ============================================================================

/// `(background, foreground)` pair for a tone, shared by tags, dots and fills.
pub fn tone_colors(tone: BadgeTone) -> (Rgba, Rgba) {
    match tone {
        BadgeTone::Neutral => (colors::subtle(), colors::muted()),
        BadgeTone::Success => (colors::success_bg(), colors::success()),
        BadgeTone::Warning => (colors::warning_bg(), colors::warning()),
        BadgeTone::Danger => (colors::danger_bg(), colors::danger()),
        BadgeTone::Gold => (colors::gold_soft(), colors::gold()),
    }
}

/// Solid fill color for bars, dots and rails (neutral uses ink, not muted).
pub fn tone_fill(tone: BadgeTone) -> Rgba {
    match tone {
        BadgeTone::Neutral => colors::ink(),
        other => tone_colors(other).1,
    }
}

pub(crate) fn mix(a: Rgba, b: Rgba, t: f32) -> Hsla {
    let t = t.clamp(0.0, 1.0);
    Hsla::from(Rgba {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
    })
}

pub(crate) fn child_id(id: &ElementId, name: impl Into<SharedString>) -> ElementId {
    ElementId::NamedChild(id.clone().into(), name.into())
}

pub(crate) fn float_shadow(alpha: f32, y: f32, blur: f32) -> Vec<BoxShadow> {
    vec![BoxShadow {
        inset: false,
        color: hsla(0.0, 0.0, 0.09, alpha),
        offset: point(px(0.0), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.0),
    }]
}

/// Paint `points` (unit-square coordinates) as a stroke, drawn up to `progress` of
/// its total length — gives checkmarks a real "pen stroke" draw-in.
pub(crate) fn paint_polyline(
    bounds: Bounds<Pixels>,
    points: &[(f32, f32)],
    progress: f32,
    stroke: f32,
    color: Hsla,
    window: &mut Window,
) {
    let p = progress.clamp(0.0, 1.0);
    if p <= 0.001 || points.len() < 2 {
        return;
    }
    let s = f32::from(bounds.size.width);
    let ox = f32::from(bounds.origin.x);
    let oy = f32::from(bounds.origin.y);
    let pts: Vec<(f32, f32)> = points
        .iter()
        .map(|(x, y)| (ox + x * s, oy + y * s))
        .collect();
    let seg: Vec<f32> = pts
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .collect();
    let mut remaining = seg.iter().sum::<f32>() * p;
    let mut b = PathBuilder::stroke(px(stroke));
    b.move_to(point(px(pts[0].0), px(pts[0].1)));
    for (i, len) in seg.iter().enumerate() {
        let (a, c) = (pts[i], pts[i + 1]);
        if remaining >= *len {
            b.line_to(point(px(c.0), px(c.1)));
            remaining -= len;
        } else {
            let f = if *len > 0.0 { remaining / len } else { 0.0 };
            b.line_to(point(px(a.0 + (c.0 - a.0) * f), px(a.1 + (c.1 - a.1) * f)));
            break;
        }
    }
    if let Ok(path) = b.build() {
        window.paint_path(path, color);
    }
}

pub(crate) const CHECK_POINTS: [(f32, f32); 3] = [(0.22, 0.52), (0.43, 0.72), (0.80, 0.30)];
const DASH_POINTS: [(f32, f32); 2] = [(0.26, 0.5), (0.74, 0.5)];

/// Checkmark that draws itself in with a spring when `on` flips to true.
pub(crate) fn animated_check(id: ElementId, on: bool, size: f32, color: Hsla) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::snappy()).to(if on { 1.0_f32 } else { 0.0 });
    div()
        .size(px(size))
        .flex_shrink_0()
        .with_spring(id, spring, move |el, p| {
            el.child(
                canvas(
                    move |_, _, _| p,
                    move |bounds, p, window, _| {
                        paint_polyline(bounds, &CHECK_POINTS, p, size * 0.14, color, window)
                    },
                )
                .size(px(size)),
            )
        })
        .into_any_element()
}

fn floating_entrance(id: &'static str, child: Div) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::sheet_float())
        .to(1.0_f32)
        .from(0.0_f32);
    div()
        .with_spring(id, spring, move |el, p| {
            el.opacity(p.clamp(0.0, 1.0))
                .mt(px(6.0 * (1.0 - p)))
                .child(child)
        })
        .into_any_element()
}

fn up_arrow(fill: Hsla, left: f32) -> AnyElement {
    div()
        .pl(px(left))
        .h(px(6.0))
        .child(
            canvas(
                |_, _, _| (),
                move |bounds, _, window, _| {
                    let ox = f32::from(bounds.origin.x);
                    let oy = f32::from(bounds.origin.y);
                    let mut b = PathBuilder::fill();
                    b.move_to(point(px(ox), px(oy + 6.0)));
                    b.line_to(point(px(ox + 6.0), px(oy)));
                    b.line_to(point(px(ox + 12.0), px(oy + 6.0)));
                    b.close();
                    if let Ok(path) = b.build() {
                        window.paint_path(path, fill);
                    }
                },
            )
            .w(px(12.0))
            .h(px(6.0)),
        )
        .into_any_element()
}

// ============================================================================
// 1. Hover tooltip
// ============================================================================

/// Dark ink tooltip view: title, optional plain-language hint and shortcut key.
pub struct FuliTooltip {
    title: SharedString,
    hint: Option<SharedString>,
    shortcut: Option<SharedString>,
}

impl Render for FuliTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let ink = Hsla::from(colors::ink());
        let mut head = div().flex().items_center().gap(px(8.0)).child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(colors::surface())
                .child(self.title.clone()),
        );
        if let Some(key) = self.shortcut.clone() {
            head = head.child(
                div()
                    .px(px(5.0))
                    .rounded(px(4.0))
                    .bg(Hsla::from(colors::surface()).opacity(0.16))
                    .text_size(typography::meta_size())
                    .text_color(colors::surface())
                    .child(key),
            );
        }
        let mut bubble = div()
            .max_w(px(260.0))
            .bg(ink)
            .rounded(layout::radius_control())
            .px(px(10.0))
            .py(px(7.0))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .shadow(float_shadow(0.22, 6.0, 18.0))
            .child(head);
        if let Some(hint) = self.hint.clone() {
            bubble = bubble.child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(Hsla::from(colors::surface()).opacity(0.72))
                    .child(hint),
            );
        }
        floating_entrance(
            "fuli-tooltip-in",
            div().pt(px(4.0)).child(up_arrow(ink, 12.0)).child(bubble),
        )
    }
}

/// Builder for `.tooltip(...)`: `div().id("x").tooltip(fuli_tooltip("保存", None, Some("⌘S".into())))`.
pub fn fuli_tooltip(
    title: impl Into<SharedString>,
    hint: Option<SharedString>,
    shortcut: Option<SharedString>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let title = title.into();
    move |_, cx| {
        cx.new(|_| FuliTooltip {
            title: title.clone(),
            hint: hint.clone(),
            shortcut: shortcut.clone(),
        })
        .into()
    }
}

/// Attach a FULI tooltip with a short (280 ms) hover delay.
pub fn with_tooltip(
    el: Stateful<Div>,
    title: impl Into<SharedString>,
    hint: Option<SharedString>,
) -> Stateful<Div> {
    el.tooltip(fuli_tooltip(title, hint, None))
        .tooltip_show_delay(Duration::from_millis(280))
}

// ============================================================================
// 7. FLA hover card
// ============================================================================

/// What a FULI Bot / FLA hover card shows.
#[derive(Debug, Clone)]
pub struct FlaProfile {
    pub name: SharedString,
    pub role: SharedString,
    pub presence: AvatarPresence,
    pub status_label: SharedString,
    pub doing: Vec<SharedString>,
    pub actions: Vec<SharedString>,
}

pub type ActionHandler = Rc<dyn Fn(&usize, &mut Window, &mut App)>;

pub struct FlaHoverCard {
    profile: FlaProfile,
    on_action: Option<ActionHandler>,
}

fn presence_tone(p: AvatarPresence) -> BadgeTone {
    match p {
        AvatarPresence::Online => BadgeTone::Success,
        AvatarPresence::Working => BadgeTone::Gold,
        AvatarPresence::Attention => BadgeTone::Warning,
        AvatarPresence::None => BadgeTone::Neutral,
    }
}

impl Render for FlaHoverCard {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let p = &self.profile;
        let (status_bg, status_fg) = tone_colors(presence_tone(p.presence));
        let mut doing = div().flex().flex_col().gap(px(6.0));
        for (i, line) in p.doing.iter().enumerate() {
            doing = doing.child(spring_entrance(
                format!("fla-card-doing-{i}"),
                0.0,
                4.0 * (i as f32 + 1.0),
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.0))
                    .child(
                        div()
                            .mt(px(6.0))
                            .size(px(5.0))
                            .flex_shrink_0()
                            .rounded(layout::radius_pill())
                            .bg(colors::gold()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .text_size(typography::control_size())
                            .text_color(colors::ink())
                            .child(line.clone()),
                    )
                    .into_any_element(),
            ));
        }
        let mut actions = div().flex().flex_wrap().gap(px(6.0));
        for (i, label) in p.actions.iter().enumerate() {
            let handler = self.on_action.clone();
            actions = actions.child(
                ghost_button(format!("fla-card-act-{i}"), label.clone(), ControlSize::Sm)
                    .border_1()
                    .border_color(colors::border())
                    .on_click(move |_, window, cx| {
                        if let Some(h) = &handler {
                            h(&i, window, cx);
                        }
                    }),
            );
        }
        let card = div()
            .w(px(300.0))
            .bg(colors::surface())
            .border_1()
            .border_color(colors::border())
            .rounded(layout::radius_card())
            .p(px(14.0))
            .flex()
            .flex_col()
            .gap(px(12.0))
            .shadow(float_shadow(0.14, 10.0, 28.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.0))
                    .child(fuli_avatar(
                        "fla-card-avatar",
                        &p.name,
                        AvatarSize::Lg,
                        p.presence,
                    ))
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .flex()
                            .flex_col()
                            .gap(px(3.0))
                            .child(
                                div()
                                    .text_size(typography::card_title_size())
                                    .font_weight(typography::WEIGHT_STRONG)
                                    .text_color(colors::ink())
                                    .truncate()
                                    .child(p.name.clone()),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .truncate()
                                    .child(p.role.clone()),
                            ),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .px(px(8.0))
                            .py(px(3.0))
                            .rounded(layout::radius_pill())
                            .bg(status_bg)
                            .child(
                                div()
                                    .size(px(6.0))
                                    .rounded(layout::radius_pill())
                                    .bg(status_fg),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(status_fg)
                                    .child(p.status_label.clone()),
                            ),
                    ),
            )
            .child(divider())
            .child(
                div()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child("最近在做"),
            )
            .child(doing)
            .child(actions);
        floating_entrance("fla-hover-card-in", div().pt(px(6.0)).child(card))
    }
}

/// Builder for `.hoverable_tooltip(...)` so the pointer can move into the card.
pub fn fla_hover_card(
    profile: FlaProfile,
    on_action: Option<ActionHandler>,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    move |_, cx| {
        cx.new(|_| FlaHoverCard {
            profile: profile.clone(),
            on_action: on_action.clone(),
        })
        .into()
    }
}

/// Attach an FLA hover card (350 ms delay, stays open while hovered).
pub fn with_fla_hover_card(
    el: Stateful<Div>,
    profile: FlaProfile,
    on_action: Option<ActionHandler>,
) -> Stateful<Div> {
    el.hoverable_tooltip(fla_hover_card(profile, on_action))
        .tooltip_show_delay(Duration::from_millis(350))
}

// ============================================================================
// 2. Switch
// ============================================================================

/// Switch with a spring-gliding knob and smoothly blended track color.
/// `on_change` receives the new value.
pub fn fuli_switch(
    id: impl Into<ElementId>,
    checked: bool,
    disabled: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let spring = SpringAnimation::new(FuliSpring::snappy()).to(if checked { 1.0_f32 } else { 0.0 });
    let track = div()
        .size_full()
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .with_spring(child_id(&id, "knob"), spring, |el, p| {
            el.bg(mix(colors::control_border(), colors::ink(), p))
                .pl(px(3.0 + 16.0 * p.clamp(-0.1, 1.1)))
                .child(
                    div()
                        .size(px(16.0))
                        .rounded(layout::radius_pill())
                        .bg(colors::surface())
                        .shadow(float_shadow(0.22, 1.0, 3.0)),
                )
        });
    let mut root = div()
        .id(id)
        .w(px(38.0))
        .h(px(22.0))
        .flex_shrink_0()
        .rounded(layout::radius_pill())
        .child(track);
    if disabled {
        root = root.opacity(0.45);
    } else {
        root = root
            .cursor_pointer()
            .hover(|s| s.opacity(0.92))
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(move |_, window, cx| on_change(&!checked, window, cx));
    }
    root
}

// ============================================================================
// 3. Checkbox
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Unchecked,
    Checked,
    Mixed,
}

/// Checkbox whose box pops with a spring and whose check / dash draws itself in.
/// `on_change` receives the new checked value (mixed → checked).
pub fn fuli_checkbox(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    state: CheckState,
    disabled: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let id: ElementId = id.into();
    let filled = state != CheckState::Unchecked;
    let fill = SpringAnimation::new(FuliSpring::snappy()).to(if filled { 1.0_f32 } else { 0.0 });
    let check = SpringAnimation::new(FuliSpring::snappy()).to(if state == CheckState::Checked {
        1.0_f32
    } else {
        0.0
    });
    let dash = SpringAnimation::new(FuliSpring::snappy()).to(if state == CheckState::Mixed {
        1.0_f32
    } else {
        0.0
    });
    let (check_id, dash_id) = (child_id(&id, "check"), child_id(&id, "dash"));
    let white = Hsla::from(colors::surface());
    let glyph = div()
        .size(px(18.0))
        .with_spring(check_id, check, move |el, pc| {
            el.child(
                div()
                    .size(px(18.0))
                    .with_spring(dash_id, dash, move |el2, pm| {
                        el2.child(
                            canvas(
                                move |_, _, _| (pc, pm),
                                move |bounds, (pc, pm), window, _| {
                                    paint_polyline(bounds, &CHECK_POINTS, pc, 2.2, white, window);
                                    paint_polyline(bounds, &DASH_POINTS, pm, 2.2, white, window);
                                },
                            )
                            .size(px(18.0)),
                        )
                    }),
            )
        });
    let boxed = div()
        .size(px(22.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .with_spring(child_id(&id, "box"), fill, move |el, p| {
            let bump = 1.0 + 0.14 * (p.clamp(0.0, 1.0) * PI).sin();
            el.child(
                div()
                    .size(px(18.0 * bump))
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(mix(colors::control_border(), colors::ink(), p))
                    .bg(mix(colors::surface(), colors::ink(), p))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(glyph),
            )
        });

    let mut text = div().flex().flex_col().gap(px(2.0)).min_w(px(0.0)).child(
        div()
            .text_size(typography::body_size())
            .text_color(colors::ink())
            .child(label.into()),
    );
    if let Some(sub) = subtitle {
        text = text.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(sub),
        );
    }
    let mut row = div()
        .id(id)
        .flex()
        .items_start()
        .gap(px(8.0))
        .child(boxed)
        .child(text);
    if disabled {
        row = row.opacity(0.45);
    } else {
        let next = state != CheckState::Checked;
        row = row
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(move |_, window, cx| on_change(&next, window, cx));
    }
    row
}

// ============================================================================
// 4. Breadcrumb
// ============================================================================

/// Breadcrumb trail. The last item is the current page; when there are more than
/// `max_visible` (min 3) items the middle collapses into `…` (hover lists them,
/// click jumps to the deepest hidden one). New tail crumbs glide in.
pub fn fuli_breadcrumb(
    id: impl Into<ElementId>,
    items: Vec<SharedString>,
    max_visible: usize,
    on_select: impl Fn(&usize, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id: ElementId = id.into();
    let on_select = Rc::new(on_select);
    let n = items.len();
    let max = max_visible.max(3);
    let tail_start = if n > max { n - (max - 2) } else { 1 };
    let hidden: Vec<usize> = if n > max {
        (1..tail_start).collect()
    } else {
        vec![]
    };

    let sep = || fuli_icon("chevron-right", 12.0, colors::control_border());
    let crumb = |i: usize, label: SharedString| -> AnyElement {
        let current = i + 1 == n;
        let base = div()
            .id(child_id(&id, format!("c{i}")))
            .h(px(26.0))
            .px(px(8.0))
            .max_w(px(180.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .text_size(typography::control_size())
            .child(div().truncate().child(label));
        if current {
            base.text_color(colors::ink())
                .font_weight(typography::WEIGHT_STRONG)
                .into_any_element()
        } else {
            let f = on_select.clone();
            base.text_color(colors::muted())
                .cursor_pointer()
                .hover(|s| s.bg(colors::hover()).text_color(colors::ink()))
                .on_click(move |_, window, cx| f(&i, window, cx))
                .into_any_element()
        }
    };

    let mut row = div().flex().items_center().gap(px(2.0)).min_w(px(0.0));
    if let Some(first) = items.first() {
        row = row.child(crumb(0, first.clone()));
    }
    if !hidden.is_empty() {
        let names: Vec<String> = hidden.iter().map(|i| items[*i].to_string()).collect();
        let deepest = *hidden.last().unwrap_or(&0);
        let f = on_select.clone();
        row = row.child(sep()).child(
            with_tooltip(
                div()
                    .id(child_id(&id, "more"))
                    .h(px(26.0))
                    .px(px(8.0))
                    .rounded(px(6.0))
                    .flex()
                    .items_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(colors::hover()))
                    .child(fuli_icon("ellipsis", 14.0, colors::muted()))
                    .on_click(move |_, window, cx| f(&deepest, window, cx)),
                format!("还有 {} 层", names.len()),
                Some(names.join(" / ").into()),
            )
            .into_any_element(),
        );
    }
    for (i, label) in items.iter().enumerate().skip(tail_start.max(1)) {
        let el = crumb(i, label.clone());
        let el = if i + 1 == n {
            spring_entrance(child_id(&id, format!("in{n}")), -8.0, 0.0, el)
        } else {
            el
        };
        row = row.child(sep()).child(el);
    }
    row.into_any_element()
}

// ============================================================================
// 6. Dialog + content building blocks
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogTone {
    Normal,
    Danger,
}

/// Dialog that springs in (fade + rise + slight grow) and springs out.
/// Keep rendering it with `open = false` so the exit plays; once fully closed it
/// renders nothing and captures no clicks. Backdrop click and ✕ call `on_close`.
#[allow(clippy::too_many_arguments)]
pub fn fuli_dialog(
    id: impl Into<ElementId>,
    open: bool,
    tone: DialogTone,
    title: impl Into<SharedString>,
    description: Option<SharedString>,
    body: AnyElement,
    footer: AnyElement,
    width: f32,
    on_close: impl Fn(&(), &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id: ElementId = id.into();
    let on_close = Rc::new(on_close);
    let spring =
        SpringAnimation::new(FuliSpring::surface_enter()).to(if open { 1.0_f32 } else { 0.0 });

    let close = on_close.clone();
    let close_btn = with_tooltip(
        div()
            .id(child_id(&id, "x"))
            .size(px(28.0))
            .flex_shrink_0()
            .rounded(layout::radius_control())
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|s| s.bg(colors::hover()))
            .child(fuli_icon("x", 15.0, colors::muted()))
            .on_click(move |_, window, cx| close(&(), window, cx)),
        "关闭",
        Some("也可以点弹窗外面".into()),
    );

    let mut head_text = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(
            div()
                .text_size(typography::section_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(colors::ink())
                .child(title.into()),
        );
    if let Some(desc) = description {
        head_text = head_text.child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::muted())
                .child(desc),
        );
    }
    let mut head = div().flex().items_start().gap(px(12.0));
    if tone == DialogTone::Danger {
        head = head.child(
            div()
                .size(px(34.0))
                .flex_shrink_0()
                .rounded(layout::radius_pill())
                .bg(colors::danger_bg())
                .flex()
                .items_center()
                .justify_center()
                .child(fuli_icon("circle-alert", 18.0, colors::danger())),
        );
    }
    head = head.child(head_text).child(close_btn);

    let card = div()
        .id(child_id(&id, "card"))
        .max_h(px(600.0))
        .bg(colors::surface())
        .border_1()
        .border_color(if tone == DialogTone::Danger {
            colors::danger_border()
        } else {
            colors::border()
        })
        .rounded(layout::radius_dialog())
        .p(px(22.0))
        .flex()
        .flex_col()
        .gap(px(14.0))
        .shadow(float_shadow(0.18, 16.0, 40.0))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(head)
        .child(divider())
        .child(body)
        .child(footer);

    let backdrop_close = on_close;
    div()
        .absolute()
        .inset_0()
        .with_spring(id, spring, move |el, p| {
            let a = p.clamp(0.0, 1.0);
            if !open && a < 0.02 {
                return el;
            }
            el.child(
                div()
                    .id("fuli-dialog-scrim")
                    .absolute()
                    .inset_0()
                    .bg(Hsla::from(colors::backdrop()).opacity(a))
                    .occlude()
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        backdrop_close(&(), window, cx)
                    }),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(width * (0.96 + 0.04 * p)))
                            .mt(px(18.0 * (1.0 - p)))
                            .opacity(a)
                            .child(card),
                    ),
            )
        })
        .into_any_element()
}

/// Labelled form row: label (+ optional "可选"), control, then a muted hint.
pub fn dialog_field(
    label: impl Into<SharedString>,
    optional: bool,
    hint: Option<SharedString>,
    control: AnyElement,
) -> AnyElement {
    let mut head = div().flex().items_center().gap(px(6.0)).child(
        div()
            .text_size(typography::control_size())
            .font_weight(typography::WEIGHT_MEDIUM)
            .text_color(colors::ink())
            .child(label.into()),
    );
    if optional {
        head = head.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child("可选"),
        );
    }
    let mut col = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(head)
        .child(control);
    if let Some(h) = hint {
        col = col.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(h),
        );
    }
    col.into_any_element()
}

/// Titled group of dialog content.
pub fn dialog_section(title: impl Into<SharedString>, children: Vec<AnyElement>) -> AnyElement {
    let mut col = div().flex().flex_col().gap(px(10.0)).child(
        div()
            .text_size(typography::meta_size())
            .font_weight(typography::WEIGHT_MEDIUM)
            .text_color(colors::muted())
            .child(title.into()),
    );
    for c in children {
        col = col.child(c);
    }
    col.into_any_element()
}

/// Tinted notice inside a dialog (warning before a destructive step, a tip, …).
pub fn dialog_callout(
    tone: BadgeTone,
    title: impl Into<SharedString>,
    detail: Option<SharedString>,
) -> AnyElement {
    let (bg, fg) = tone_colors(tone);
    let icon = match tone {
        BadgeTone::Danger | BadgeTone::Warning => "circle-alert",
        BadgeTone::Success => "circle-check",
        _ => "info",
    };
    let mut text = div()
        .flex_1()
        .min_w(px(0.0))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .text_size(typography::control_size())
                .font_weight(typography::WEIGHT_MEDIUM)
                .text_color(fg)
                .child(title.into()),
        );
    if let Some(d) = detail {
        text = text.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(d),
        );
    }
    div()
        .flex()
        .items_start()
        .gap(px(10.0))
        .p(px(12.0))
        .rounded(layout::radius_control())
        .bg(bg)
        .child(fuli_icon(icon, 16.0, fg))
        .child(text)
        .into_any_element()
}

/// Key → value line for confirmation summaries.
pub fn dialog_kv(key: impl Into<SharedString>, value: impl Into<SharedString>) -> AnyElement {
    div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .py(px(6.0))
        .border_b_1()
        .border_color(colors::border())
        .child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::muted())
                .child(key.into()),
        )
        .child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::ink())
                .truncate()
                .child(value.into()),
        )
        .into_any_element()
}

/// Scrollable body for long dialog content.
pub fn dialog_scroll_body(id: impl Into<ElementId>, max_h: f32, content: Div) -> AnyElement {
    div()
        .id(id.into())
        .max_h(px(max_h))
        .overflow_y_scroll()
        .pr(px(4.0))
        .child(content.flex().flex_col().gap(px(14.0)))
        .into_any_element()
}

/// Footer: optional left slot (e.g. "不再提醒" checkbox) + right-aligned buttons.
pub fn dialog_footer(left: Option<AnyElement>, actions: Vec<AnyElement>) -> AnyElement {
    let mut right = div().flex().items_center().gap(px(8.0));
    for a in actions {
        right = right.child(a);
    }
    div()
        .pt(px(4.0))
        .flex()
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .child(div().flex_1().min_w(px(0.0)).children(left))
        .child(right)
        .into_any_element()
}

// ============================================================================
// 8. Progress
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProgressValue {
    Determinate(f32),
    Indeterminate,
}

fn progress_header(
    id: &ElementId,
    label: Option<SharedString>,
    value: ProgressValue,
    show_percent: bool,
) -> Option<AnyElement> {
    if label.is_none() && !show_percent {
        return None;
    }
    let mut row = div()
        .flex()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::ink())
                .children(label),
        );
    if show_percent {
        row = row.child(match value {
            ProgressValue::Determinate(r) => div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .with_spring(
                    child_id(id, "pct"),
                    SpringAnimation::new(FuliSpring::gentle()).to(r.clamp(0.0, 1.0)),
                    |el, p| el.child(format!("{:.0}%", (p * 100.0).clamp(0.0, 100.0))),
                )
                .into_any_element(),
            ProgressValue::Indeterminate => div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child("处理中…")
                .into_any_element(),
        });
    }
    Some(row.into_any_element())
}

/// Progress bar: determinate fills with a spring (percent counts up alongside);
/// indeterminate shows a gliding light streak.
pub fn fuli_progress(
    id: impl Into<ElementId>,
    value: ProgressValue,
    label: Option<SharedString>,
    show_percent: bool,
    tone: BadgeTone,
) -> AnyElement {
    let id: ElementId = id.into();
    let fill = tone_fill(tone);
    let track = div()
        .relative()
        .w_full()
        .h(px(8.0))
        .rounded(layout::radius_pill())
        .bg(colors::subtle())
        .border_1()
        .border_color(colors::border())
        .overflow_hidden();
    let bar = match value {
        ProgressValue::Determinate(r) => track.child(
            div()
                .h_full()
                .rounded(layout::radius_pill())
                .bg(fill)
                .with_spring(
                    child_id(&id, "fill"),
                    SpringAnimation::new(FuliSpring::gentle()).to(r.clamp(0.0, 1.0)),
                    |el, p| el.w(relative(p.clamp(0.0, 1.0))),
                ),
        ),
        ProgressValue::Indeterminate => track.child(
            div()
                .absolute()
                .top_0()
                .h_full()
                .w(relative(0.34))
                .rounded(layout::radius_pill())
                .bg(fill)
                .with_animation(
                    child_id(&id, "streak"),
                    Animation::new(Duration::from_millis(1500)).repeat(),
                    |el, t| {
                        let e = apple_ease_out(t);
                        el.left(relative(-0.34 + 1.34 * e))
                            .opacity(0.55 + 0.45 * (t * PI).sin())
                    },
                ),
        ),
    };
    div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .children(progress_header(&id, label, value, show_percent))
        .child(bar)
        .into_any_element()
}

#[derive(Debug, Clone)]
pub struct ProgressSegment {
    pub label: SharedString,
    pub ratio: f32,
    pub tone: BadgeTone,
}

/// Stacked segmented bar (e.g. 已确认 / 待拍板 / 已过时) with a legend.
pub fn segmented_progress(
    id: impl Into<ElementId>,
    segments: Vec<ProgressSegment>,
    show_legend: bool,
) -> AnyElement {
    let id: ElementId = id.into();
    let mut bar = div()
        .w_full()
        .h(px(10.0))
        .flex()
        .gap(px(2.0))
        .rounded(layout::radius_pill())
        .bg(colors::subtle())
        .overflow_hidden();
    let mut legend = div().flex().flex_wrap().gap(px(14.0));
    for (i, seg) in segments.iter().enumerate() {
        let fill = tone_fill(seg.tone);
        bar = bar.child(div().h_full().bg(fill).with_spring(
            child_id(&id, format!("s{i}")),
            SpringAnimation::new(FuliSpring::gentle()).to(seg.ratio.clamp(0.0, 1.0)),
            |el, p| el.w(relative(p.clamp(0.0, 1.0))),
        ));
        legend = legend.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.0))
                .child(div().size(px(8.0)).rounded(px(2.0)).bg(fill))
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(format!("{} {:.0}%", seg.label, seg.ratio * 100.0)),
                ),
        );
    }
    let mut col = div().w_full().flex().flex_col().gap(px(8.0)).child(bar);
    if show_legend {
        col = col.child(legend);
    }
    col.into_any_element()
}
