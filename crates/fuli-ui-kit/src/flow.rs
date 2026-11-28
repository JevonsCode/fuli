//! Calendar, steps and timeline with spring motion. The timeline is the building
//! block for the FULI run log (one row per step, tag + duration + expandable detail).

use std::cmp::Ordering;
use std::f32::consts::PI;
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::{
    Animation, AnimationExt as _, AnyElement, App, ElementId, Hsla, InteractiveElement,
    IntoElement, ParentElement, SharedString, SpringAnimation, StatefulInteractiveElement, Styled,
    Window, div, px, relative,
};

use crate::brand::fuli_icon;
use crate::motion::{FuliSpring, apple_stagger_card, collapsible_reveal};
use crate::primitives::BadgeTone;
use crate::rich::{animated_check, child_id, mix, tone_colors, tone_fill};
use crate::tokens::{colors, layout, typography};

// ============================================================================
// 5. Calendar
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CalDate {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

impl PartialOrd for CalDate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for CalDate {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.y, self.m, self.d).cmp(&(other.y, other.m, other.d))
    }
}

pub fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// 0 = Monday … 6 = Sunday.
pub fn weekday_monday0(y: i32, m: u32, d: u32) -> u32 {
    const T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let yy = if m < 3 { y - 1 } else { y };
    let sun0 = (yy + yy / 4 - yy / 100 + yy / 400 + T[(m - 1) as usize] + d as i32).rem_euclid(7);
    ((sun0 + 6) % 7) as u32
}

impl CalDate {
    pub fn new(y: i32, m: u32, d: u32) -> Self {
        Self { y, m, d }
    }

    /// Civil date for a day count since 1970-01-01.
    pub fn from_unix_days(days: i64) -> Self {
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = (yoe + era * 400 + i64::from(m <= 2)) as i32;
        Self { y, m, d }
    }

    /// Today at a fixed UTC offset (no tz database in the kit; pass e.g. 8 for UTC+8).
    pub fn today_at_offset(offset_hours: i32) -> Self {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
            + i64::from(offset_hours) * 3600;
        Self::from_unix_days(secs.div_euclid(86_400))
    }

    fn shift_month(y: i32, m: u32, delta: i32) -> (i32, u32) {
        let idx = y * 12 + (m as i32 - 1) + delta;
        (idx.div_euclid(12), (idx.rem_euclid(12) + 1) as u32)
    }
}

/// View + selection state the caller owns (single date, or range when `range_mode`).
#[derive(Debug, Clone)]
pub struct CalendarState {
    pub view_year: i32,
    pub view_month: u32,
    pub selected: Option<CalDate>,
    pub range_end: Option<CalDate>,
    pub range_mode: bool,
    nav_dir: i32,
}

impl CalendarState {
    pub fn new(around: CalDate, range_mode: bool) -> Self {
        Self {
            view_year: around.y,
            view_month: around.m,
            selected: None,
            range_end: None,
            range_mode,
            nav_dir: 0,
        }
    }

    pub fn shift_month(&mut self, delta: i32) {
        let (y, m) = CalDate::shift_month(self.view_year, self.view_month, delta);
        self.view_year = y;
        self.view_month = m;
        self.nav_dir = delta.signum();
    }

    pub fn pick(&mut self, date: CalDate) {
        if (date.y, date.m) != (self.view_year, self.view_month) {
            let delta =
                (date.y * 12 + date.m as i32) - (self.view_year * 12 + self.view_month as i32);
            self.shift_month(delta);
        }
        if !self.range_mode {
            self.selected = Some(date);
            self.range_end = None;
            return;
        }
        match (self.selected, self.range_end) {
            (Some(start), None) if date != start => {
                let (a, b) = if date < start {
                    (date, start)
                } else {
                    (start, date)
                };
                self.selected = Some(a);
                self.range_end = Some(b);
            }
            _ => {
                self.selected = Some(date);
                self.range_end = None;
            }
        }
    }

    fn is_edge(&self, d: CalDate) -> bool {
        self.selected == Some(d) || self.range_end == Some(d)
    }

    fn in_range(&self, d: CalDate) -> bool {
        matches!((self.selected, self.range_end), (Some(a), Some(b)) if d > a && d < b)
    }

    /// Plain-language summary of the current selection.
    pub fn summary(&self) -> String {
        let f = |d: CalDate| format!("{}-{:02}-{:02}", d.y, d.m, d.d);
        match (self.selected, self.range_end) {
            (Some(a), Some(b)) => {
                let span = days_between(a, b) + 1;
                format!("{} → {} · 共 {span} 天", f(a), f(b))
            }
            (Some(a), None) if self.range_mode => format!("{} → 再点一天作为结束", f(a)),
            (Some(a), None) => format!("已选 {}", f(a)),
            _ => "还没选日期".into(),
        }
    }
}

fn day_index(d: CalDate) -> i64 {
    let (y, m) = if d.m <= 2 {
        (d.y as i64 - 1, d.m as i64 + 9)
    } else {
        (d.y as i64, d.m as i64 - 3)
    };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d.d as i64 - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy
}

fn days_between(a: CalDate, b: CalDate) -> i64 {
    day_index(b) - day_index(a)
}

/// Month calendar. Switching months slides the grid in from the navigation side;
/// today gets a gold dot; picked days pop in with a spring; ranges get a soft band.
pub fn fuli_calendar(
    id: impl Into<ElementId>,
    state: &CalendarState,
    today: CalDate,
    on_nav: impl Fn(&i32, &mut Window, &mut App) + 'static,
    on_pick: impl Fn(&CalDate, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id: ElementId = id.into();
    let on_nav = Rc::new(on_nav);
    let on_pick = Rc::new(on_pick);
    let (y, m) = (state.view_year, state.view_month);

    let nav_btn = |name: &'static str, icon: &'static str, delta: i32| {
        let f = on_nav.clone();
        div()
            .id(child_id(&id, name))
            .size(px(28.0))
            .rounded(layout::radius_control())
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(|s| s.bg(colors::hover()))
            .child(fuli_icon(icon, 15.0, colors::muted()))
            .on_click(move |_, window, cx| f(&delta, window, cx))
    };
    let header = div()
        .flex()
        .items_center()
        .justify_between()
        .child(nav_btn("prev", "chevron-left", -1))
        .child(
            div()
                .text_size(typography::card_title_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(colors::ink())
                .child(format!("{y} 年 {m} 月")),
        )
        .child(nav_btn("next", "chevron-right", 1));

    let mut week = div().flex();
    for w in ["一", "二", "三", "四", "五", "六", "日"] {
        week = week.child(
            div()
                .flex_1()
                .h(px(24.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(w),
        );
    }

    let lead = weekday_monday0(y, m, 1) as i32;
    let (py, pm) = CalDate::shift_month(y, m, -1);
    let (ny, nm) = CalDate::shift_month(y, m, 1);
    let mut grid = div().flex().flex_col().gap(px(2.0));
    for row in 0..6 {
        let mut r = div().flex();
        for col in 0..7 {
            let n = row * 7 + col - lead + 1;
            let dim = days_in_month(y, m) as i32;
            let (date, outside) = if n < 1 {
                (
                    CalDate::new(py, pm, (days_in_month(py, pm) as i32 + n) as u32),
                    true,
                )
            } else if n > dim {
                (CalDate::new(ny, nm, (n - dim) as u32), true)
            } else {
                (CalDate::new(y, m, n as u32), false)
            };
            let edge = state.is_edge(date);
            let band = state.in_range(date);
            let is_today = date == today;
            let f = on_pick.clone();
            let sel =
                SpringAnimation::new(FuliSpring::snappy()).to(if edge { 1.0_f32 } else { 0.0 });
            let text_color = if outside {
                colors::control_border()
            } else if is_today {
                colors::gold()
            } else {
                colors::ink()
            };
            let cell_base = div()
                .id(child_id(&id, format!("d{}-{}-{}", date.y, date.m, date.d)))
                .flex_1()
                .h(px(36.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer();
            let cell_base = if band {
                cell_base.bg(colors::gold_soft())
            } else {
                cell_base
            };
            let cell = cell_base
                .on_click(move |_, window, cx| f(&date, window, cx))
                .child(
                    div()
                        .size(px(32.0))
                        .flex()
                        .items_center()
                        .justify_center()
                        .with_spring(
                            child_id(&id, format!("sel{}-{}-{}", date.y, date.m, date.d)),
                            sel,
                            move |el, p| {
                                let a = p.clamp(0.0, 1.0);
                                let size = 32.0 * (0.55 + 0.45 * p);
                                let mut dot = div().size(px(4.0)).rounded(layout::radius_pill());
                                if is_today {
                                    dot = dot.bg(colors::gold());
                                }
                                el.child(
                                    div()
                                        .size(px(size.max(0.0)))
                                        .rounded(layout::radius_pill())
                                        .bg(Hsla::from(colors::ink()).opacity(a))
                                        .hover(|s| s.bg(colors::hover()))
                                        .flex()
                                        .flex_col()
                                        .items_center()
                                        .justify_center()
                                        .child(
                                            div()
                                                .text_size(typography::control_size())
                                                .text_color(mix(text_color, colors::surface(), a))
                                                .font_weight(if is_today {
                                                    typography::WEIGHT_STRONG
                                                } else {
                                                    typography::WEIGHT_REGULAR
                                                })
                                                .child(date.d.to_string()),
                                        )
                                        .child(dot),
                                )
                            },
                        ),
                );
            r = r.child(cell);
        }
        grid = grid.child(r);
    }

    let dir = state.nav_dir as f32;
    let slide = SpringAnimation::new(FuliSpring::surface_enter())
        .to(1.0_f32)
        .from(0.0_f32);
    let animated_grid = div().overflow_hidden().child(div().with_spring(
        child_id(&id, format!("grid{y}-{m}")),
        slide,
        move |el, p| {
            el.opacity(p.clamp(0.0, 1.0))
                .ml(px(28.0 * dir * (1.0 - p)))
                .child(grid)
        },
    ));

    div()
        .w(px(300.0))
        .p(px(14.0))
        .bg(colors::surface())
        .border_1()
        .border_color(colors::border())
        .rounded(layout::radius_card())
        .flex()
        .flex_col()
        .gap(px(8.0))
        .child(header)
        .child(week)
        .child(animated_grid)
        .child(
            div()
                .pt(px(4.0))
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(state.summary()),
        )
        .into_any_element()
}

// ============================================================================
// 9. Steps
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Done,
    Current,
    Pending,
    Error,
}

#[derive(Debug, Clone)]
pub struct StepItem {
    pub title: SharedString,
    pub description: Option<SharedString>,
    pub status: StepStatus,
}

impl StepItem {
    pub fn new(title: impl Into<SharedString>, status: StepStatus) -> Self {
        Self {
            title: title.into(),
            description: None,
            status,
        }
    }
    pub fn description(mut self, d: impl Into<SharedString>) -> Self {
        self.description = Some(d.into());
        self
    }
}

fn step_node(id: &ElementId, idx: usize, status: StepStatus) -> AnyElement {
    let fill = SpringAnimation::new(FuliSpring::snappy()).to(if status == StepStatus::Done {
        1.0_f32
    } else {
        0.0
    });
    let num = (idx + 1).to_string();
    let check_id = child_id(id, format!("ck{idx}"));
    let node =
        div()
            .size(px(26.0))
            .with_spring(child_id(id, format!("nf{idx}")), fill, move |el, p| {
                let (border, bg) = match status {
                    StepStatus::Done => (colors::ink(), colors::ink()),
                    StepStatus::Current => (colors::gold(), colors::surface()),
                    StepStatus::Error => (colors::danger(), colors::danger_bg()),
                    StepStatus::Pending => (colors::control_border(), colors::surface()),
                };
                let inner = match status {
                    StepStatus::Done => {
                        animated_check(check_id, true, 16.0, Hsla::from(colors::surface()))
                    }
                    StepStatus::Error => fuli_icon("x", 13.0, colors::danger()),
                    _ => div()
                        .text_size(typography::meta_size())
                        .font_weight(typography::WEIGHT_STRONG)
                        .text_color(if status == StepStatus::Current {
                            colors::gold()
                        } else {
                            colors::muted()
                        })
                        .child(num)
                        .into_any_element(),
                };
                el.rounded(layout::radius_pill())
                    .border_2()
                    .border_color(border)
                    .bg(if status == StepStatus::Done {
                        mix(colors::surface(), bg, p)
                    } else {
                        Hsla::from(bg)
                    })
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(inner)
            });
    let halo = div()
        .size(px(36.0))
        .flex_shrink_0()
        .rounded(layout::radius_pill())
        .flex()
        .items_center()
        .justify_center();
    if status == StepStatus::Current {
        halo.with_animation(
            child_id(id, format!("halo{idx}")),
            Animation::new(Duration::from_millis(1800)).repeat(),
            |el, t| {
                let wave = 0.5 - 0.5 * (t * 2.0 * PI).cos();
                el.bg(Hsla::from(colors::gold()).opacity(0.22 * (1.0 - wave) + 0.04))
            },
        )
        .child(node)
        .into_any_element()
    } else {
        halo.child(node).into_any_element()
    }
}

fn step_connector(id: &ElementId, idx: usize, done: bool, vertical: bool) -> AnyElement {
    let spring = SpringAnimation::new(FuliSpring::gentle()).to(if done { 1.0_f32 } else { 0.0 });
    let track = if vertical {
        div().w(px(2.0)).flex_1().min_h(px(18.0))
    } else {
        div().h(px(2.0)).flex_1().min_w(px(16.0))
    };
    track
        .rounded(layout::radius_pill())
        .bg(colors::border())
        .overflow_hidden()
        .child(
            div()
                .bg(colors::ink())
                .rounded(layout::radius_pill())
                .with_spring(child_id(id, format!("ln{idx}")), spring, move |el, p| {
                    let p = relative(p.clamp(0.0, 1.0));
                    if vertical {
                        el.w_full().h(p)
                    } else {
                        el.h_full().w(p)
                    }
                }),
        )
        .into_any_element()
}

fn step_text(item: &StepItem) -> AnyElement {
    let color = match item.status {
        StepStatus::Pending => colors::muted(),
        StepStatus::Error => colors::danger(),
        _ => colors::ink(),
    };
    let mut col = div().flex().flex_col().gap(px(2.0)).min_w(px(0.0)).child(
        div()
            .text_size(typography::control_size())
            .font_weight(if item.status == StepStatus::Current {
                typography::WEIGHT_STRONG
            } else {
                typography::WEIGHT_MEDIUM
            })
            .text_color(color)
            .child(item.title.clone()),
    );
    if let Some(d) = item.description.clone() {
        col = col.child(
            div()
                .text_size(typography::meta_size())
                .text_color(colors::muted())
                .child(d),
        );
    }
    col.into_any_element()
}

/// Step indicator, horizontal or vertical. Done steps draw a check, the current
/// step breathes gold, connectors fill with a spring as steps complete.
pub fn fuli_steps(id: impl Into<ElementId>, items: &[StepItem], vertical: bool) -> AnyElement {
    let id: ElementId = id.into();
    let n = items.len();
    if vertical {
        let mut col = div().flex().flex_col();
        for (i, item) in items.iter().enumerate() {
            let mut rail =
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(step_node(&id, i, item.status));
            if i + 1 < n {
                rail = rail.child(step_connector(
                    &id,
                    i,
                    item.status == StepStatus::Done,
                    true,
                ));
            }
            col = col.child(
                div().flex().gap(px(10.0)).child(rail).child(
                    div()
                        .flex_1()
                        .pt(px(8.0))
                        .pb(px(14.0))
                        .child(step_text(item)),
                ),
            );
        }
        col.into_any_element()
    } else {
        let mut row = div().flex().items_start().w_full();
        for (i, item) in items.iter().enumerate() {
            let mut top =
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.0))
                    .child(step_node(&id, i, item.status));
            if i + 1 < n {
                top = top.child(step_connector(
                    &id,
                    i,
                    item.status == StepStatus::Done,
                    false,
                ));
            }
            let cell = div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(top)
                .child(div().pr(px(12.0)).child(step_text(item)));
            row = row.child(if i + 1 < n {
                cell.flex_1().min_w(px(0.0))
            } else {
                cell.flex_shrink_0()
            });
        }
        row.into_any_element()
    }
}

// ============================================================================
// 10. Timeline
// ============================================================================

/// One timeline row (also one step of the FULI run log).
pub struct TimelineEntry {
    pub tag: SharedString,
    pub tone: BadgeTone,
    pub title: SharedString,
    pub subtitle: Option<SharedString>,
    pub time: Option<SharedString>,
    pub duration: Option<SharedString>,
    pub detail: Option<AnyElement>,
    pub expanded: bool,
}

impl TimelineEntry {
    pub fn new(
        tag: impl Into<SharedString>,
        tone: BadgeTone,
        title: impl Into<SharedString>,
    ) -> Self {
        Self {
            tag: tag.into(),
            tone,
            title: title.into(),
            subtitle: None,
            time: None,
            duration: None,
            detail: None,
            expanded: false,
        }
    }
    pub fn subtitle(mut self, s: impl Into<SharedString>) -> Self {
        self.subtitle = Some(s.into());
        self
    }
    pub fn time(mut self, s: impl Into<SharedString>) -> Self {
        self.time = Some(s.into());
        self
    }
    pub fn duration(mut self, s: impl Into<SharedString>) -> Self {
        self.duration = Some(s.into());
        self
    }
    pub fn detail(mut self, el: AnyElement) -> Self {
        self.detail = Some(el);
        self
    }
    pub fn expanded(mut self, open: bool) -> Self {
        self.expanded = open;
        self
    }
}

/// Small tone-colored tag pill used in timeline rows.
pub fn timeline_tag(tag: impl Into<SharedString>, tone: BadgeTone) -> AnyElement {
    let (bg, fg) = tone_colors(tone);
    div()
        .flex_shrink_0()
        .px(px(7.0))
        .py(px(1.0))
        .rounded(px(5.0))
        .bg(bg)
        .text_size(typography::meta_size())
        .font_weight(typography::WEIGHT_MEDIUM)
        .text_color(fg)
        .child(tag.into())
        .into_any_element()
}

/// Vertical event stream: rows cascade in, rows with detail expand with a spring.
pub fn fuli_timeline(
    id: impl Into<ElementId>,
    entries: Vec<TimelineEntry>,
    on_toggle: impl Fn(&usize, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id: ElementId = id.into();
    let on_toggle = Rc::new(on_toggle);
    let n = entries.len();
    let mut col = div().flex().flex_col();
    for (i, e) in entries.into_iter().enumerate() {
        let fill = tone_fill(e.tone);
        let mut rail = div()
            .w(px(18.0))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .items_center()
            .child(
                div()
                    .mt(px(12.0))
                    .size(px(10.0))
                    .flex_shrink_0()
                    .rounded(layout::radius_pill())
                    .border_2()
                    .border_color(fill)
                    .bg(colors::surface()),
            );
        if i + 1 < n {
            rail = rail.child(div().w(px(2.0)).flex_1().mt(px(2.0)).bg(colors::border()));
        }

        let has_detail = e.detail.is_some();
        let mut head = div()
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(timeline_tag(e.tag.clone(), e.tone))
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.0))
                    .truncate()
                    .text_size(typography::control_size())
                    .font_weight(typography::WEIGHT_MEDIUM)
                    .text_color(colors::ink())
                    .child(e.title.clone()),
            );
        if let Some(d) = e.duration.clone() {
            head = head.child(
                div()
                    .flex_shrink_0()
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(d),
            );
        }
        if has_detail {
            head = head.child(fuli_icon(
                if e.expanded {
                    "chevron-down"
                } else {
                    "chevron-right"
                },
                14.0,
                colors::muted(),
            ));
        }
        let mut body = div().flex().flex_col().gap(px(3.0)).child(head);
        if e.subtitle.is_some() || e.time.is_some() {
            body = body.child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.0))
                            .truncate()
                            .children(e.subtitle.clone()),
                    )
                    .children(e.time.clone()),
            );
        }
        let mut card = div()
            .id(child_id(&id, format!("row{i}")))
            .flex_1()
            .min_w(px(0.0))
            .px(px(10.0))
            .py(px(8.0))
            .rounded(layout::radius_control())
            .child(body);
        if has_detail {
            let f = on_toggle.clone();
            card = card
                .cursor_pointer()
                .hover(|s| s.bg(colors::subtle()))
                .on_click(move |_, window, cx| f(&i, window, cx));
        }
        let mut right = div()
            .flex_1()
            .min_w(px(0.0))
            .flex()
            .flex_col()
            .pb(px(4.0))
            .child(card);
        if let Some(detail) = e.detail {
            right = right.child(collapsible_reveal(
                child_id(&id, format!("dt{i}")),
                e.expanded,
                div()
                    .ml(px(10.0))
                    .mt(px(2.0))
                    .mb(px(6.0))
                    .p(px(10.0))
                    .rounded(layout::radius_control())
                    .bg(colors::subtle())
                    .border_1()
                    .border_color(colors::border())
                    .child(detail)
                    .into_any_element(),
            ));
        }
        let row = div()
            .flex()
            .gap(px(6.0))
            .child(rail)
            .child(right)
            .into_any_element();
        col = col.child(apple_stagger_card(child_id(&id, format!("st{i}")), i, row));
    }
    col.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_math_is_correct() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2026, 11), 30);
        // 2026-11-28 is a Saturday (Monday = 0).
        assert_eq!(weekday_monday0(2026, 11, 28), 5);
        assert_eq!(weekday_monday0(2026, 11, 1), 6);
        assert_eq!(CalDate::from_unix_days(0), CalDate::new(1970, 1, 1));
        assert_eq!(CalDate::from_unix_days(20_420), CalDate::new(2025, 11, 28));
        assert_eq!(
            days_between(CalDate::new(2026, 2, 27), CalDate::new(2026, 3, 2)),
            3
        );
    }

    #[test]
    fn range_pick_orders_and_restarts() {
        let mut s = CalendarState::new(CalDate::new(2026, 11, 1), true);
        s.pick(CalDate::new(2026, 11, 20));
        s.pick(CalDate::new(2026, 11, 3));
        assert_eq!(s.selected, Some(CalDate::new(2026, 11, 3)));
        assert_eq!(s.range_end, Some(CalDate::new(2026, 11, 20)));
        assert!(s.summary().contains("共 18 天"));
        s.pick(CalDate::new(2026, 12, 5));
        assert_eq!((s.view_year, s.view_month), (2026, 12));
        assert_eq!(s.range_end, None);
        s.shift_month(-13);
        assert_eq!((s.view_year, s.view_month), (2025, 11));
    }
}
