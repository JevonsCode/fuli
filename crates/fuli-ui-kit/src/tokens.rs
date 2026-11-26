use gpui_kit::{FontWeight, Pixels, Rgba, px, rgb, rgba};

/// FULI light minimalist palette:
/// warm neutral canvas, pure white hairline-bordered cards, near-black ink
/// for primary actions, muted gold for compounding & progress, crimson strictly
/// for hard-rule conflicts or destructive actions.
pub mod colors {
    use super::*;

    pub const CANVAS_HEX: u32 = 0xf2f2ef;
    pub const SURFACE_HEX: u32 = 0xffffff;
    pub const SUBTLE_HEX: u32 = 0xf7f7f4;
    pub const HOVER_HEX: u32 = 0xededec;
    pub const INK_HEX: u32 = 0x17171a;
    pub const MUTED_HEX: u32 = 0x66666d;
    pub const GOLD_HEX: u32 = 0xa8824a;
    pub const BORDER_HEX: u32 = 0xe6e6e1;
    pub const CONTROL_BORDER_HEX: u32 = 0xc4c4bd;
    pub const SUCCESS_HEX: u32 = 0x087b63;
    pub const SUCCESS_BG_HEX: u32 = 0xe6f4ef;
    pub const WARNING_HEX: u32 = 0x92400e;
    pub const WARNING_BG_HEX: u32 = 0xfef3c7;
    pub const DANGER_HEX: u32 = 0xb42318;
    pub const DANGER_BG_HEX: u32 = 0xfef2f2;
    pub const DANGER_BORDER_HEX: u32 = 0xfecdca;

    pub fn canvas() -> Rgba {
        rgb(CANVAS_HEX)
    }
    pub fn surface() -> Rgba {
        rgb(SURFACE_HEX)
    }
    pub fn subtle() -> Rgba {
        rgb(SUBTLE_HEX)
    }
    pub fn hover() -> Rgba {
        rgb(HOVER_HEX)
    }
    pub fn ink() -> Rgba {
        rgb(INK_HEX)
    }
    pub fn ink_hover() -> Rgba {
        rgb(0x2c2c31)
    }
    pub fn muted() -> Rgba {
        rgb(MUTED_HEX)
    }
    pub fn gold() -> Rgba {
        rgb(GOLD_HEX)
    }
    pub fn gold_soft() -> Rgba {
        rgba(0xa8824a24)
    }
    pub fn border() -> Rgba {
        rgb(BORDER_HEX)
    }
    pub fn control_border() -> Rgba {
        rgb(CONTROL_BORDER_HEX)
    }
    pub fn success() -> Rgba {
        rgb(SUCCESS_HEX)
    }
    pub fn success_bg() -> Rgba {
        rgb(SUCCESS_BG_HEX)
    }
    pub fn warning() -> Rgba {
        rgb(WARNING_HEX)
    }
    pub fn warning_bg() -> Rgba {
        rgb(WARNING_BG_HEX)
    }
    pub fn danger() -> Rgba {
        rgb(DANGER_HEX)
    }
    pub fn danger_bg() -> Rgba {
        rgb(DANGER_BG_HEX)
    }
    pub fn danger_border() -> Rgba {
        rgb(DANGER_BORDER_HEX)
    }
    pub fn dock_surface() -> Rgba {
        rgba(0xfffffff2)
    }
}

/// Shared 4px spacing scale and corner radii.
pub mod layout {
    use super::*;

    pub fn radius_control() -> Pixels {
        px(8.0)
    }
    pub fn radius_card() -> Pixels {
        px(14.0)
    }
    pub fn radius_dialog() -> Pixels {
        px(20.0)
    }
    pub fn radius_pill() -> Pixels {
        px(999.0)
    }
}

/// Type hierarchy: headings 600, controls 500, body 400. Never 700.
pub mod typography {
    use super::*;

    pub fn title_size() -> Pixels {
        px(22.0)
    }
    pub fn section_size() -> Pixels {
        px(16.0)
    }
    pub fn card_title_size() -> Pixels {
        px(15.0)
    }
    pub fn body_size() -> Pixels {
        px(14.0)
    }
    pub fn control_size() -> Pixels {
        px(13.0)
    }
    pub fn meta_size() -> Pixels {
        px(12.0)
    }
    pub fn headline_figure_size() -> Pixels {
        px(60.0)
    }

    pub const WEIGHT_REGULAR: FontWeight = FontWeight::NORMAL;
    pub const WEIGHT_MEDIUM: FontWeight = FontWeight::MEDIUM;
    pub const WEIGHT_STRONG: FontWeight = FontWeight::SEMIBOLD;
}

/// Unified three-step control size scale (`sm 30 / md 36 / lg 44`) so controls
/// placed side-by-side in any row always share exact height and alignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSize {
    Sm,
    Md,
    Lg,
}

impl ControlSize {
    pub fn height(self) -> Pixels {
        match self {
            Self::Sm => px(30.0),
            Self::Md => px(36.0),
            Self::Lg => px(44.0),
        }
    }

    pub fn padding_x(self) -> Pixels {
        match self {
            Self::Sm => px(10.0),
            Self::Md => px(14.0),
            Self::Lg => px(20.0),
        }
    }

    pub fn font_size(self) -> Pixels {
        match self {
            Self::Sm => typography::meta_size(),
            Self::Md => typography::control_size(),
            Self::Lg => typography::body_size(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_sizes_follow_strict_30_36_44_scale() {
        assert_eq!(ControlSize::Sm.height(), px(30.0));
        assert_eq!(ControlSize::Md.height(), px(36.0));
        assert_eq!(ControlSize::Lg.height(), px(44.0));
    }

    #[test]
    fn palette_constants_match_light_minimalist_design() {
        assert_eq!(colors::CANVAS_HEX, 0xf2f2ef);
        assert_eq!(colors::SURFACE_HEX, 0xffffff);
        assert_eq!(colors::INK_HEX, 0x17171a);
        assert_eq!(colors::GOLD_HEX, 0xa8824a);
        assert_eq!(colors::DANGER_HEX, 0xb42318);
    }
}
