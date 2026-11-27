//! Complete form controls: Radio, Checkbox, Single Select, Searchable Select, Multi-Select Dropdown & Search Input.
//! Built atop `gpui-component`'s keyboard-accessible primitives and styled with FULI tokens & `ControlSize`.

use gpui_kit::{
    AnyElement, App, ElementId, Entity, IntoElement, ParentElement, SharedString, Styled, Window,
    component::{
        checkbox::Checkbox,
        combobox::{Combobox, ComboboxState},
        input::{Input, InputState},
        radio::Radio,
        select::{SearchableVec, Select, SelectState},
    },
    div, px,
};

use crate::brand::fuli_icon;
use crate::tokens::{ControlSize, colors, layout, typography};

pub use gpui_kit::component::IndexPath;
pub use gpui_kit::component::combobox::ComboboxEvent;
pub use gpui_kit::component::select::SelectEvent;

/// Convenient string-option delegate backed by `SearchableVec<SharedString>`.
pub type StringSelectDelegate = SearchableVec<SharedString>;
pub type SingleSelectState = SelectState<StringSelectDelegate>;
pub type MultiSelectState = ComboboxState<StringSelectDelegate>;

/// Build a `SearchableVec<SharedString>` from any iterator of labels.
pub fn select_options<I, S>(items: I) -> StringSelectDelegate
where
    I: IntoIterator<Item = S>,
    S: Into<SharedString>,
{
    SearchableVec::new(items.into_iter().map(Into::into).collect::<Vec<_>>())
}

/// Accessible Radio item with optional plain-language subtitle.
pub fn radio_item(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    checked: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let title: SharedString = label.into();
    let radio = Radio::new(id)
        .checked(checked)
        .on_change(on_change)
        .label(title);

    if let Some(sub) = subtitle {
        div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(radio)
            .child(
                div()
                    .pl(px(24.0))
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(sub),
            )
            .into_any_element()
    } else {
        radio.into_any_element()
    }
}

/// Vertical or horizontal Radio group container with clean spacing.
pub fn radio_group(horizontal: bool, items: Vec<AnyElement>) -> AnyElement {
    let mut container = div()
        .flex()
        .gap(if horizontal { px(18.0) } else { px(10.0) });
    if horizontal {
        container = container.flex_wrap().items_center();
    } else {
        container = container.flex_col();
    }
    for item in items {
        container = container.child(item);
    }
    container.into_any_element()
}

/// Accessible Checkbox item supporting checked, unchecked, and indeterminate (partial) states.
pub fn checkbox_item(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    subtitle: Option<SharedString>,
    checked: bool,
    indeterminate: bool,
    on_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let title: SharedString = label.into();
    let cb = Checkbox::new(id)
        .checked(checked)
        .indeterminate(indeterminate)
        .on_change(on_change)
        .label(title);

    if let Some(sub) = subtitle {
        div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(cb)
            .child(
                div()
                    .pl(px(24.0))
                    .text_size(typography::meta_size())
                    .text_color(colors::muted())
                    .child(sub),
            )
            .into_any_element()
    } else {
        cb.into_any_element()
    }
}

/// Vertical or horizontal Checkbox group container.
pub fn checkbox_group(horizontal: bool, items: Vec<AnyElement>) -> AnyElement {
    let mut container = div()
        .flex()
        .gap(if horizontal { px(16.0) } else { px(10.0) });
    if horizontal {
        container = container.flex_wrap().items_center();
    } else {
        container = container.flex_col();
    }
    for item in items {
        container = container.child(item);
    }
    container.into_any_element()
}

/// Single-select dropdown (`下拉单选`) styled with FULI's `ControlSize` height & clean clear button.
pub fn select_single(
    state: &Entity<SingleSelectState>,
    placeholder: impl Into<SharedString>,
    size: ControlSize,
) -> AnyElement {
    Select::new(state)
        .placeholder(placeholder)
        .cleanable(true)
        .h(size.height())
        .into_any_element()
}

/// Searchable single-select dropdown (`下拉可搜索单选`) with live match highlighting.
/// Construct state with `SelectState::new(select_options(...), ..., window, cx).searchable(true)`.
pub fn select_searchable(
    state: &Entity<SingleSelectState>,
    placeholder: impl Into<SharedString>,
    search_placeholder: impl Into<SharedString>,
    size: ControlSize,
) -> AnyElement {
    Select::new(state)
        .placeholder(placeholder)
        .search_placeholder(search_placeholder)
        .highlight_matches(true)
        .cleanable(true)
        .h(size.height())
        .into_any_element()
}

/// Multi-select searchable dropdown (`下拉多选`) showing selected count / chips cleanly.
/// Construct state with `ComboboxState::new(select_options(...), ..., window, cx).multiple(true).searchable(true)`.
pub fn select_multi(
    state: &Entity<MultiSelectState>,
    placeholder: impl Into<SharedString>,
    search_placeholder: impl Into<SharedString>,
    size: ControlSize,
) -> AnyElement {
    Combobox::new(state)
        .placeholder(placeholder)
        .search_placeholder(search_placeholder)
        .highlight_matches(true)
        .cleanable(true)
        .h(size.height())
        .into_any_element()
}

/// Dedicated search input box with leading Lucide search icon and native CN/EN IME support.
pub fn search_input_box(state: &Entity<InputState>, size: ControlSize) -> AnyElement {
    div()
        .w_full()
        .h(size.height())
        .px(px(10.0))
        .rounded(layout::radius_control())
        .bg(colors::surface())
        .border_1()
        .border_color(colors::control_border())
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(fuli_icon("search", 14.0, colors::muted()))
        .child(
            div().flex_1().child(
                Input::new(state)
                    .appearance(false)
                    .cleanable(true)
                    .h(px(f32::from(size.height()) - 4.0)),
            ),
        )
        .into_any_element()
}
