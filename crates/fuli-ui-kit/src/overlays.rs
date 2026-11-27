//! Rich Overlay & Notification System with Apple-calibrated GPUI spring entrances & smooth scrim fades:
//! - Top & Bottom auto-dismissing toast reminders (`ToastPlacement::Top | Bottom`) with countdown bar & undo slot
//! - Alert / Confirmation dialogs (`alert_dialog`) with tone icon & synchronized backdrop fade
//! - Guided step-by-step tour popovers (`guided_tour_popover`) with step dots & Next/Prev/Skip controls

use std::time::Duration;

use gpui_kit::{
    AnyElement, BoxShadow, ElementId, IntoElement, ParentElement, SharedString, Styled, div, hsla,
    point, px, rgb, rgba,
};

use crate::brand::fuli_icon;
use crate::motion::{backdrop_fade, sheet_spring_entrance, spring_entrance, toast_countdown_bar};
use crate::primitives::{BadgeTone, divider, status_badge};
use crate::tokens::{colors, layout, typography};

/// Screen placement for floating reminders / auto-dismiss toasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToastPlacement {
    TopCenter,
    TopRight,
    BottomCenter,
    BottomRight,
}

/// Rich floating toast / temporary reminder with Apple spring slide-in, optional action (e.g. 撤销 / 查看),
/// close button, and smooth auto-dismiss countdown bar.
#[allow(clippy::too_many_arguments)]
pub fn floating_toast_overlay(
    id: impl Into<ElementId>,
    placement: ToastPlacement,
    tone: BadgeTone,
    title: impl Into<SharedString>,
    detail: Option<SharedString>,
    auto_dismiss: Option<Duration>,
    action_slot: Option<AnyElement>,
    close_slot: Option<AnyElement>,
) -> AnyElement {
    let elem_id: ElementId = id.into();
    let (icon_name, accent, border_col) = match tone {
        BadgeTone::Success => ("check", colors::success(), rgb(0xa7f3d0)),
        BadgeTone::Warning => ("info", colors::warning(), rgb(0xfde68a)),
        BadgeTone::Danger => ("shield", colors::danger(), colors::danger_border()),
        BadgeTone::Gold => ("sparkles", colors::gold(), rgb(0xe5d5bd)),
        BadgeTone::Neutral => ("info", colors::ink(), colors::border()),
    };

    let mut header_row = div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .child(
            div()
                .size(px(26.0))
                .rounded(layout::radius_pill())
                .bg(colors::subtle())
                .flex()
                .items_center()
                .justify_center()
                .flex_shrink_0()
                .child(fuli_icon(icon_name, 14.0, accent)),
        )
        .child(
            div()
                .flex_1()
                .min_w(px(0.0))
                .flex()
                .flex_col()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(typography::control_size())
                        .font_weight(typography::WEIGHT_MEDIUM)
                        .text_color(colors::ink())
                        .child(title.into()),
                )
                .children(detail.map(|d| {
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(d)
                })),
        );

    if let Some(act) = action_slot {
        header_row = header_row.child(act);
    }
    if let Some(close) = close_slot {
        header_row = header_row.child(close);
    }

    let mut card = div()
        .w(px(390.0))
        .bg(rgba(0xfffffff8))
        .border_1()
        .border_color(border_col)
        .rounded(layout::radius_card())
        .px(px(14.0))
        .py(px(11.0))
        .flex()
        .flex_col()
        .gap(px(8.0))
        .shadow(vec![BoxShadow {
            inset: false,
            color: hsla(0.0, 0.0, 0.09, 0.13),
            offset: point(px(0.0), px(8.0)),
            blur_radius: px(24.0),
            spread_radius: px(0.0),
        }])
        .child(header_row);

    if let Some(dur) = auto_dismiss {
        card = card.child(toast_countdown_bar(
            ElementId::NamedChild(elem_id.clone().into(), "bar".into()),
            dur,
            accent,
        ));
    }

    let from_y = match placement {
        ToastPlacement::TopCenter | ToastPlacement::TopRight => -16.0,
        ToastPlacement::BottomCenter | ToastPlacement::BottomRight => 16.0,
    };

    let animated = sheet_spring_entrance(elem_id, 0.0, from_y, card.into_any_element());

    match placement {
        ToastPlacement::TopCenter => div()
            .absolute()
            .top(px(62.0))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(animated)
            .into_any_element(),
        ToastPlacement::TopRight => div()
            .absolute()
            .top(px(62.0))
            .right(px(24.0))
            .child(animated)
            .into_any_element(),
        ToastPlacement::BottomCenter => div()
            .absolute()
            .bottom(px(20.0))
            .left_0()
            .right_0()
            .flex()
            .justify_center()
            .child(animated)
            .into_any_element(),
        ToastPlacement::BottomRight => div()
            .absolute()
            .bottom(px(20.0))
            .right(px(24.0))
            .child(animated)
            .into_any_element(),
    }
}

/// Focused confirmation / reminder dialog with tone icon badge, smooth scrim fade & Apple spring settle.
pub fn alert_dialog(
    id: impl Into<ElementId>,
    tone: BadgeTone,
    title: impl Into<SharedString>,
    message: impl Into<SharedString>,
    footer: AnyElement,
) -> AnyElement {
    let elem_id: ElementId = id.into();
    let scrim_id = ElementId::NamedChild(elem_id.clone().into(), "scrim".into());
    let (icon_name, bg, fg) = match tone {
        BadgeTone::Danger => ("shield", colors::danger_bg(), colors::danger()),
        BadgeTone::Warning => ("info", colors::warning_bg(), colors::warning()),
        BadgeTone::Success => ("check", colors::success_bg(), colors::success()),
        _ => ("sparkles", colors::gold_soft(), colors::gold()),
    };

    let card = div()
        .w(px(430.0))
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
            color: hsla(0.0, 0.0, 0.09, 0.18),
            offset: point(px(0.0), px(14.0)),
            blur_radius: px(36.0),
            spread_radius: px(0.0),
        }])
        .child(
            div()
                .flex()
                .items_start()
                .gap(px(12.0))
                .child(
                    div()
                        .size(px(36.0))
                        .rounded(layout::radius_pill())
                        .bg(bg)
                        .flex()
                        .items_center()
                        .justify_center()
                        .flex_shrink_0()
                        .child(fuli_icon(icon_name, 18.0, fg)),
                )
                .child(
                    div()
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
                        )
                        .child(
                            div()
                                .text_size(typography::body_size())
                                .text_color(colors::muted())
                                .child(message.into()),
                        ),
                ),
        )
        .child(divider())
        .child(
            div()
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
        .child(spring_entrance(elem_id, 0.0, 14.0, card.into_any_element()));

    backdrop_fade(scrim_id, colors::backdrop(), wrapper)
}

/// Anchor placement for step-by-step guided tour popovers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TourAnchor {
    TopLeft,
    TopRight,
    BottomLeftAboveDock,
    Center,
}

/// Interactive step-by-step guided onboarding / feature tour card (`引导式弹窗`)
/// with progress dots (`1 / N`), golden highlight border, and fluid Apple sheet entrance.
#[allow(clippy::too_many_arguments)]
pub fn guided_tour_popover(
    id: impl Into<ElementId>,
    anchor: TourAnchor,
    step_index: usize,
    total_steps: usize,
    badge_label: impl Into<SharedString>,
    title: impl Into<SharedString>,
    body: impl Into<SharedString>,
    controls: AnyElement,
) -> AnyElement {
    let elem_id: ElementId = id.into();
    let mut dots = div().flex().items_center().gap(px(5.0));
    for i in 0..total_steps.max(1) {
        let active = i == step_index;
        dots = dots.child(
            div()
                .h(px(6.0))
                .w(if active { px(18.0) } else { px(6.0) })
                .rounded(layout::radius_pill())
                .bg(if active {
                    colors::gold()
                } else {
                    colors::border()
                }),
        );
    }

    let card = div()
        .w(px(360.0))
        .bg(colors::surface())
        .border_1()
        .border_color(rgb(0xe5d5bd))
        .rounded(layout::radius_dialog())
        .p(px(18.0))
        .flex()
        .flex_col()
        .gap(px(10.0))
        .shadow(vec![BoxShadow {
            inset: false,
            color: hsla(0.08, 0.20, 0.14, 0.18),
            offset: point(px(0.0), px(12.0)),
            blur_radius: px(32.0),
            spread_radius: px(0.0),
        }])
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(status_badge(badge_label, BadgeTone::Gold))
                .child(
                    div()
                        .text_size(typography::meta_size())
                        .text_color(colors::muted())
                        .child(format!("{} / {}", step_index + 1, total_steps.max(1))),
                ),
        )
        .child(
            div()
                .text_size(typography::section_size())
                .font_weight(typography::WEIGHT_STRONG)
                .text_color(colors::ink())
                .child(title.into()),
        )
        .child(
            div()
                .text_size(typography::control_size())
                .text_color(colors::muted())
                .child(body.into()),
        )
        .child(
            div()
                .pt(px(6.0))
                .flex()
                .items_center()
                .justify_between()
                .gap(px(10.0))
                .child(dots)
                .child(controls),
        );

    let animated = sheet_spring_entrance(elem_id.clone(), 0.0, 12.0, card.into_any_element());

    match anchor {
        TourAnchor::TopLeft => div()
            .absolute()
            .top(px(66.0))
            .left(px(32.0))
            .child(animated)
            .into_any_element(),
        TourAnchor::TopRight => div()
            .absolute()
            .top(px(66.0))
            .right(px(32.0))
            .child(animated)
            .into_any_element(),
        TourAnchor::BottomLeftAboveDock => div()
            .absolute()
            .bottom(px(82.0))
            .left(px(28.0))
            .child(animated)
            .into_any_element(),
        TourAnchor::Center => {
            let scrim_id = ElementId::NamedChild(elem_id.into(), "scrim".into());
            let wrapper = div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(animated);
            backdrop_fade(scrim_id, rgba(0x17171a26), wrapper)
        }
    }
}
