//! Full-Bleed Infinite Pan & Zoom Radial Constellation Relationship Map (`关系图谱`).
//!
//! Visual DNA aligned with FULI's calm craft aesthetic:
//! - Full-viewport interactive dot-grid canvas with 120fps drag-pan & scroll-wheel zoom
//! - Center obsidian medallion (`我` / Personal Global Rules)
//! - Apple App-Icon Squircle (`28%` corner radius) medallions for permanent projects + unclipped label underneath
//! - Crisp dashed squircle medallions for Temporary Projects (`临时项目` / unassigned sessions)
//! - Outward-bowed cross-project Bezier arcs with animated flowing gold light beads & 100% opaque outer-apex badges
//! - On-demand floating right frosted inspector drawer (appears when clicking a project or `关联管理`)

use std::f32::consts::{FRAC_PI_2, TAU};
use std::time::Duration;

use fuli_domain::{KbLinkType, LinkAuthority, RuleScope, RuleStatus};
use fuli_ui_kit::{
    BadgeTone, ControlSize, colors, empty_state, fuli_icon, inset_panel, layout, primary_button,
    scroll_area, secondary_button, section_card, section_header, spring_entrance, stat_tile,
    status_badge, top_icon_button, typography,
};
use gpui_kit::*;
use serde_json::json;

use super::{FuliAppView, NavTab, tr};

const SQUIRCLE_PALETTE: [(u32, u32); 6] = [
    (0xf3ece0, 0x7c5b2b), // warm parchment + gold ink
    (0xe6f4ef, 0x087b63), // sage mint + emerald
    (0xedf0f7, 0x334155), // cool slate + ink
    (0xf5ece8, 0x8a4b38), // terracotta clay
    (0xefeaf6, 0x5b4682), // muted iris
    (0xebf3f5, 0x265c6b), // mist teal
];

fn squircle_palette_for(name: &str) -> (u32, u32) {
    let mut hash: u32 = 2166136261;
    for b in name.as_bytes() {
        hash ^= u32::from(*b);
        hash = hash.wrapping_mul(16777619);
    }
    SQUIRCLE_PALETTE[(hash as usize) % SQUIRCLE_PALETTE.len()]
}

fn squircle_monogram(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "FL".into();
    }
    let first = trimmed.chars().next().unwrap_or('F');
    if !first.is_ascii() {
        return first.to_string();
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

fn is_temporary_project(name: &str, description: &str) -> bool {
    let n = name.to_lowercase();
    let d = description.to_lowercase();
    n.contains("临时")
        || n.contains("temp")
        || n.contains("会话项目")
        || d.contains("临时项目")
        || d.contains("temporary project")
}

/// Paint a crisp dashed or solid rounded-square (Apple squircle) perimeter on the GPUI Canvas.
#[allow(clippy::too_many_arguments)]
fn paint_squircle_outline(
    ox: Pixels,
    oy: Pixels,
    cx: f32,
    cy: f32,
    size: f32,
    dashed: bool,
    stroke_w: f32,
    color: Rgba,
    window: &mut Window,
) {
    let half = size * 0.5;
    let r = (size * 0.28).clamp(4.0, half);
    let left = cx - half;
    let right = cx + half;
    let top = cy - half;
    let bottom = cy + half;

    let mut pb = PathBuilder::stroke(px(stroke_w));
    if dashed {
        pb = pb.dash_array(&[px(6.0), px(4.5)]);
    }
    pb.move_to(point(ox + px(left + r), oy + px(top)));
    pb.line_to(point(ox + px(right - r), oy + px(top)));
    pb.arc_to(
        point(px(r), px(r)),
        px(0.0),
        false,
        true,
        point(ox + px(right), oy + px(top + r)),
    );
    pb.line_to(point(ox + px(right), oy + px(bottom - r)));
    pb.arc_to(
        point(px(r), px(r)),
        px(0.0),
        false,
        true,
        point(ox + px(right - r), oy + px(bottom)),
    );
    pb.line_to(point(ox + px(left + r), oy + px(bottom)));
    pb.arc_to(
        point(px(r), px(r)),
        px(0.0),
        false,
        true,
        point(ox + px(left), oy + px(bottom - r)),
    );
    pb.line_to(point(ox + px(left), oy + px(top + r)));
    pb.arc_to(
        point(px(r), px(r)),
        px(0.0),
        false,
        true,
        point(ox + px(left + r), oy + px(top)),
    );
    pb.close();
    if let Ok(path) = pb.build() {
        window.paint_path(path, color);
    }
}

impl FuliAppView {
    pub(crate) fn render_graph(&self, cx: &mut Context<Self>) -> Div {
        let l = self.locale();
        let data = &self.status.data;
        let pan = self.graph_pan;
        let zoom = self.graph_zoom.clamp(0.45, 1.85);

        let active_links: Vec<_> = data
            .kb_links
            .iter()
            .filter(|lk| lk.authority != LinkAuthority::Revoked)
            .collect();

        #[derive(Clone)]
        struct RawItem {
            agent_id: String,
            kb_id: String,
            name: String,
            description: String,
            item_count: usize,
            rule_count: usize,
            is_temp: bool,
        }

        let mut raw_items: Vec<RawItem> = data
            .agents
            .iter()
            .map(|ac| {
                let kb_id = ac
                    .mounts
                    .first()
                    .map(|m| m.kb_id.clone())
                    .or_else(|| {
                        data.knowledge_bases
                            .iter()
                            .find(|k| k.name.starts_with(&ac.agent.name))
                            .map(|k| k.id.clone())
                    })
                    .unwrap_or_default();
                let item_count = data.kb_items.iter().filter(|i| i.kb_id == kb_id).count();
                let rule_count = data
                    .rules
                    .iter()
                    .filter(|r| r.scope_kind == RuleScope::Agent && r.scope_id == ac.agent.id)
                    .count();
                let is_temp = is_temporary_project(&ac.agent.name, &ac.agent.description);
                RawItem {
                    agent_id: ac.agent.id.clone(),
                    kb_id,
                    name: ac.agent.name.clone(),
                    description: ac.agent.description.clone(),
                    item_count,
                    rule_count,
                    is_temp,
                }
            })
            .collect();

        // If any live sessions are not yet bound to a formal project, materialize them cleanly
        // as a dashed Temporary Project node on the constellation so unplaced work stays visible.
        let unassigned_sessions = data
            .sessions
            .iter()
            .filter(|s| s.agent_id.is_none())
            .count();
        if unassigned_sessions > 0 && !raw_items.iter().any(|r| r.is_temp) {
            raw_items.push(RawItem {
                agent_id: "__temp_unassigned__".into(),
                kb_id: "__temp_unassigned__".into(),
                name: tr(l, "临时项目", "Temporary").into(),
                description: format!(
                    "{} {}",
                    unassigned_sessions,
                    tr(
                        l,
                        "条未归属会话暂存在此，不污染正式项目知识库；反复出现时可一键转正。",
                        "unassigned sessions live here safely without polluting formal projects."
                    )
                ),
                item_count: unassigned_sessions,
                rule_count: 0,
                is_temp: true,
            });
        }

        // Order projects around the radial constellation so linked neighbors sit adjacent on the orbit!
        // This guarantees cross-project Bezier arcs stay short, outward-bowed, and tangle-free.
        let mut ordered_idx: Vec<usize> = Vec::with_capacity(raw_items.len());
        let mut visited = vec![false; raw_items.len()];

        let degree_of = |idx: usize| -> usize {
            let kb = &raw_items[idx].kb_id;
            active_links
                .iter()
                .filter(|lk| lk.from_kb_id == *kb || lk.to_kb_id == *kb)
                .count()
        };

        // Pick connected components first (highest degree first), traversing neighbors greedily
        let mut seed_order: Vec<usize> = (0..raw_items.len()).collect();
        seed_order.sort_by(|&a, &b| {
            raw_items[a]
                .is_temp
                .cmp(&raw_items[b].is_temp)
                .then(degree_of(b).cmp(&degree_of(a)))
                .then(
                    (raw_items[b].item_count + raw_items[b].rule_count)
                        .cmp(&(raw_items[a].item_count + raw_items[a].rule_count)),
                )
        });

        for seed in seed_order {
            if visited[seed] {
                continue;
            }
            let mut stack = vec![seed];
            while let Some(curr) = stack.pop() {
                if visited[curr] {
                    continue;
                }
                visited[curr] = true;
                ordered_idx.push(curr);
                let kb = &raw_items[curr].kb_id;
                for lk in &active_links {
                    let neighbor_kb = if lk.from_kb_id == *kb {
                        Some(&lk.to_kb_id)
                    } else if lk.to_kb_id == *kb {
                        Some(&lk.from_kb_id)
                    } else {
                        None
                    };
                    if let Some(nkb) = neighbor_kb
                        && let Some(n_idx) = raw_items.iter().position(|r| &r.kb_id == nkb)
                        && !visited[n_idx]
                    {
                        stack.push(n_idx);
                    }
                }
            }
        }

        #[derive(Clone)]
        struct ConstellationNode {
            agent_id: String,
            kb_id: String,
            name: String,
            description: String,
            item_count: usize,
            rule_count: usize,
            is_temp: bool,
            wx: f32,
            wy: f32,
        }

        // Compute airy radial world coordinates (in logical px relative to canvas center (0, 0)).
        // Up to 8 nodes on Orbit 1 (R = 232px); overflow cleanly placed on Orbit 2 (R = 395px).
        let inner_count = ordered_idx.len().min(8);
        let outer_count = ordered_idx.len().saturating_sub(inner_count);
        let r_inner = if inner_count <= 5 {
            215.0_f32
        } else {
            236.0_f32
        };
        let r_outer = 395.0_f32;

        let mut nodes: Vec<ConstellationNode> = Vec::with_capacity(ordered_idx.len());
        for (pos, &raw_i) in ordered_idx.iter().enumerate() {
            let item = &raw_items[raw_i];
            let (wx, wy) = if pos < inner_count {
                let denom = inner_count.max(1) as f32;
                let angle = -FRAC_PI_2 + (pos as f32) * (TAU / denom);
                // Slightly elliptical horizontally (1.16x) to harmonize with widescreen desktop aspect ratio
                (angle.cos() * r_inner * 1.18, angle.sin() * r_inner * 0.94)
            } else {
                let o_pos = pos - inner_count;
                let denom = outer_count.max(1) as f32;
                let angle = -FRAC_PI_2 + (o_pos as f32 + 0.5) * (TAU / denom);
                (angle.cos() * r_outer * 1.15, angle.sin() * r_outer * 0.92)
            };
            nodes.push(ConstellationNode {
                agent_id: item.agent_id.clone(),
                kb_id: item.kb_id.clone(),
                name: item.name.clone(),
                description: item.description.clone(),
                item_count: item.item_count,
                rule_count: item.rule_count,
                is_temp: item.is_temp,
                wx,
                wy,
            });
        }

        let selected_kb = self.graph_selected_kb_id.as_deref();

        // Precompute world-space Bezier cross-project edges (outward-bowed so they NEVER cover nodes/text!)
        #[derive(Clone)]
        struct WorldCrossEdge {
            p1x: f32,
            p1y: f32,
            c1x: f32,
            c1y: f32,
            c2x: f32,
            c2y: f32,
            p2x: f32,
            p2y: f32,
            apex_x: f32,
            apex_y: f32,
            confirmed: bool,
            highlighted: bool,
            dimmed: bool,
            label: String,
        }

        let mut cross_edges: Vec<WorldCrossEdge> = Vec::new();
        let mut placed_world_pills: Vec<(f32, f32)> = Vec::new();

        for link in &active_links {
            if let (Some(a), Some(b)) = (
                nodes.iter().find(|n| n.kb_id == link.from_kb_id),
                nodes.iter().find(|n| n.kb_id == link.to_kb_id),
            ) {
                let hi = selected_kb.is_some_and(|s| s == a.kb_id || s == b.kb_id);
                let dimmed = selected_kb.is_some() && !hi;

                let mx = (a.wx + b.wx) * 0.5;
                let my = (a.wy + b.wy) * 0.5;
                let m_len = (mx * mx + my * my).hypot(0.0);

                // Outward normal away from center (0, 0); if opposite across center, use clean chord normal
                let (nx, ny) = if m_len > 36.0 {
                    (mx / m_len, my / m_len)
                } else {
                    let dx = b.wx - a.wx;
                    let dy = b.wy - a.wy;
                    let d = dx.hypot(dy).max(1.0);
                    (-dy / d, dx / d)
                };

                let chord = (b.wx - a.wx).hypot(b.wy - a.wy);
                let mut bow = (chord * 0.34).clamp(72.0, 128.0);

                // If another pill is already near this outward apex, bow slightly further out so pills never overlap
                let mut test_ax = mx + nx * (bow * 0.75);
                let mut test_ay = my + ny * (bow * 0.75);
                for &(px0, py0) in &placed_world_pills {
                    if (test_ax - px0).abs() < 78.0 && (test_ay - py0).abs() < 34.0 {
                        bow += 42.0;
                        test_ax = mx + nx * (bow * 0.75);
                        test_ay = my + ny * (bow * 0.75);
                    }
                }

                let c1x = a.wx * 0.68 + b.wx * 0.32 + nx * bow;
                let c1y = a.wy * 0.68 + b.wy * 0.32 + ny * bow;
                let c2x = a.wx * 0.32 + b.wx * 0.68 + nx * bow;
                let c2y = a.wy * 0.32 + b.wy * 0.68 + ny * bow;

                // Attach ports cleanly to the outer edge of each 74px squircle (offset ~42px along tangent)
                let port_offset = 42.0_f32;
                let t1x = c1x - a.wx;
                let t1y = c1y - a.wy;
                let t1_len = t1x.hypot(t1y).max(1.0);
                let p1x = a.wx + (t1x / t1_len) * port_offset;
                let p1y = a.wy + (t1y / t1_len) * port_offset;

                let t2x = c2x - b.wx;
                let t2y = c2y - b.wy;
                let t2_len = t2x.hypot(t2y).max(1.0);
                let p2x = b.wx + (t2x / t2_len) * port_offset;
                let p2y = b.wy + (t2y / t2_len) * port_offset;

                // Exact cubic Bezier midpoint B(0.5)
                let apex_x = 0.125 * p1x + 0.375 * c1x + 0.375 * c2x + 0.125 * p2x;
                let apex_y = 0.125 * p1y + 0.375 * c1y + 0.375 * c2y + 0.125 * p2y;
                placed_world_pills.push((apex_x, apex_y));

                let rel_label = if link.authority == LinkAuthority::HumanConfirmed {
                    match link.relation_type {
                        KbLinkType::Cites => tr(l, "共用知识", "Shares KB").to_string(),
                        KbLinkType::Inherits => tr(l, "继承规则", "Inherits").to_string(),
                    }
                } else {
                    tr(l, "待拍板", "Pending").to_string()
                };

                cross_edges.push(WorldCrossEdge {
                    p1x,
                    p1y,
                    c1x,
                    c1y,
                    c2x,
                    c2y,
                    p2x,
                    p2y,
                    apex_x,
                    apex_y,
                    confirmed: link.authority == LinkAuthority::HumanConfirmed,
                    highlighted: hi,
                    dimmed,
                    label: rel_label,
                });
            }
        }

        #[derive(Clone)]
        struct SpokeSpec {
            wx: f32,
            wy: f32,
            is_temp: bool,
            highlighted: bool,
            dimmed: bool,
        }

        let spokes: Vec<SpokeSpec> = nodes
            .iter()
            .map(|n| {
                let hi = selected_kb == Some(n.kb_id.as_str());
                let related = selected_kb.is_none()
                    || hi
                    || active_links.iter().any(|lk| {
                        selected_kb.is_some_and(|s| {
                            (lk.from_kb_id == s && lk.to_kb_id == n.kb_id)
                                || (lk.to_kb_id == s && lk.from_kb_id == n.kb_id)
                        })
                    });
                SpokeSpec {
                    wx: n.wx,
                    wy: n.wy,
                    is_temp: n.is_temp,
                    highlighted: hi,
                    dimmed: !related,
                }
            })
            .collect();

        let temp_node_coords: Vec<(f32, f32, bool)> = nodes
            .iter()
            .filter(|n| n.is_temp)
            .map(|n| (n.wx, n.wy, selected_kb == Some(n.kb_id.as_str())))
            .collect();

        let global_rule_count = data
            .rules
            .iter()
            .filter(|r| r.scope_kind == RuleScope::PersonalGlobal && r.status == RuleStatus::Active)
            .count();

        let tile_world = 74.0_f32;
        let hub_world = 74.0_f32;
        let edges_for_pills = cross_edges.clone();

        // Layer 1: Infinite world-locked Dot-Grid + Radial Spokes + Outward Bezier Arcs + Flowing Beads + Dashed Temp Outlines
        let canvas_layer = div().absolute().inset_0().with_animation(
            "graph-constellation-flow",
            Animation::new(Duration::from_millis(2800)).repeat_synced(),
            move |el, flow_t| {
                let spokes_snap = spokes.clone();
                let edges_snap = cross_edges.clone();
                let temps_snap = temp_node_coords.clone();
                el.child(
                    canvas(
                        move |_, _, _| (spokes_snap, edges_snap, temps_snap, flow_t),
                        move |bounds, (spokes_list, edges_list, temps_list, t), window, _| {
                            let w = f32::from(bounds.size.width).max(1.0);
                            let h = f32::from(bounds.size.height).max(1.0);
                            let ox = bounds.origin.x;
                            let oy = bounds.origin.y;
                            let cx0 = w * 0.5;
                            let cy0 = h * 0.5;

                            let to_screen = |wx: f32, wy: f32| -> (f32, f32) {
                                (cx0 + (wx + pan.0) * zoom, cy0 + (wy + pan.1) * zoom)
                            };

                            let paint_circle =
                                |sx: f32, sy: f32, r: f32, color: Rgba, win: &mut Window| {
                                    let c = point(ox + px(sx), oy + px(sy));
                                    let mut dot = PathBuilder::fill();
                                    dot.move_to(point(c.x + px(r), c.y));
                                    dot.arc_to(
                                        point(px(r), px(r)),
                                        px(0.0),
                                        false,
                                        true,
                                        point(c.x - px(r), c.y),
                                    );
                                    dot.arc_to(
                                        point(px(r), px(r)),
                                        px(0.0),
                                        false,
                                        true,
                                        point(c.x + px(r), c.y),
                                    );
                                    dot.close();
                                    if let Ok(path) = dot.build() {
                                        win.paint_path(path, color);
                                    }
                                };

                            // 1. World-locked infinite 28px architectural dot-grid (moves smoothly as you pan & zoom!)
                            let step = (28.0 * zoom).clamp(14.0, 56.0);
                            let phase_x = (cx0 + pan.0 * zoom).rem_euclid(step);
                            let phase_y = (cy0 + pan.1 * zoom).rem_euclid(step);
                            let dot_r = (1.05 * zoom.sqrt()).clamp(0.85, 1.45);
                            let mut gx = phase_x;
                            while gx < w {
                                let mut gy = phase_y;
                                while gy < h {
                                    paint_circle(gx, gy, dot_r, rgba(0x17171a16), window);
                                    gy += step;
                                }
                                gx += step;
                            }

                            // 2. Subtle ambient orbital guide ring around center `我` (very faint, architectural)
                            let (hub_sx, hub_sy) = to_screen(0.0, 0.0);
                            let orbit_rx = r_inner * 1.18 * zoom;
                            let orbit_ry = r_inner * 0.94 * zoom;
                            if orbit_rx > 40.0 && orbit_ry > 40.0 {
                                let mut ring = PathBuilder::stroke(px(1.0));
                                ring = ring.dash_array(&[px(3.0), px(7.0)]);
                                let steps = 72;
                                for i in 0..=steps {
                                    let a = (i as f32) * (TAU / (steps as f32));
                                    let rx = hub_sx + a.cos() * orbit_rx;
                                    let ry = hub_sy + a.sin() * orbit_ry;
                                    let p = point(ox + px(rx), oy + px(ry));
                                    if i == 0 {
                                        ring.move_to(p);
                                    } else {
                                        ring.line_to(p);
                                    }
                                }
                                if let Ok(path) = ring.build() {
                                    window.paint_path(path, rgba(0x17171a10));
                                }
                            }

                            // 3. Radial spokes from center `我` to every project squircle
                            for sp in &spokes_list {
                                let dist = sp.wx.hypot(sp.wy).max(1.0);
                                let ux = sp.wx / dist;
                                let uy = sp.wy / dist;
                                let start_r = hub_world * 0.5 + 4.0;
                                let end_r = (dist - tile_world * 0.5 - 6.0).max(start_r + 4.0);
                                let (sx1, sy1) = to_screen(ux * start_r, uy * start_r);
                                let (sx2, sy2) = to_screen(ux * end_r, uy * end_r);

                                let mut pb =
                                    PathBuilder::stroke(px(if sp.highlighted { 1.6 } else { 1.1 }));
                                if sp.is_temp {
                                    pb = pb.dash_array(&[px(4.5), px(4.5)]);
                                }
                                pb.move_to(point(ox + px(sx1), oy + px(sy1)));
                                pb.line_to(point(ox + px(sx2), oy + px(sy2)));
                                if let Ok(path) = pb.build() {
                                    let col = if sp.highlighted {
                                        rgba(0x17171a66)
                                    } else if sp.dimmed {
                                        rgba(0x17171a12)
                                    } else {
                                        rgba(0x17171a22)
                                    };
                                    window.paint_path(path, col);
                                }
                            }

                            // 4. Outward-bowed cross-project Bezier links + soft halos + port dots + flowing gold beads
                            for e in &edges_list {
                                let (sx1, sy1) = to_screen(e.p1x, e.p1y);
                                let (sc1x, sc1y) = to_screen(e.c1x, e.c1y);
                                let (sc2x, sc2y) = to_screen(e.c2x, e.c2y);
                                let (sx2, sy2) = to_screen(e.p2x, e.p2y);

                                let p1 = point(ox + px(sx1), oy + px(sy1));
                                let c1 = point(ox + px(sc1x), oy + px(sc1y));
                                let c2 = point(ox + px(sc2x), oy + px(sc2y));
                                let p2 = point(ox + px(sx2), oy + px(sy2));

                                if !e.dimmed && (e.confirmed || e.highlighted) {
                                    let mut halo = PathBuilder::stroke(px(7.0 * zoom.sqrt()));
                                    halo.move_to(p1);
                                    halo.cubic_bezier_to(p2, c1, c2);
                                    if let Ok(path) = halo.build() {
                                        window.paint_path(path, rgba(0xa8824a22));
                                    }
                                }

                                let sw = if e.highlighted {
                                    2.5
                                } else if e.confirmed {
                                    2.1
                                } else {
                                    1.7
                                };
                                let mut pb = PathBuilder::stroke(px(sw));
                                if !e.confirmed {
                                    pb = pb.dash_array(&[px(6.5), px(4.5)]);
                                }
                                pb.move_to(p1);
                                pb.cubic_bezier_to(p2, c1, c2);
                                if let Ok(path) = pb.build() {
                                    let col = if e.dimmed {
                                        rgba(0x17171a22)
                                    } else if e.confirmed {
                                        if e.highlighted {
                                            rgba(0x17171aff)
                                        } else {
                                            rgba(0x17171ad8)
                                        }
                                    } else if e.highlighted {
                                        rgba(0xa8824aff)
                                    } else {
                                        rgba(0xa8824acc)
                                    };
                                    window.paint_path(path, col);
                                }

                                // Connector port dots
                                let port_col = if e.dimmed {
                                    rgba(0x17171a28)
                                } else if e.confirmed {
                                    rgba(0x17171ae0)
                                } else {
                                    rgba(0xa8824ae0)
                                };
                                let pr = (3.4 * zoom.sqrt()).clamp(2.4, 4.5);
                                paint_circle(sx1, sy1, pr, port_col, window);
                                paint_circle(sx2, sy2, pr, port_col, window);

                                // Flowing gold light bead along authorized links
                                if e.confirmed && !e.dimmed {
                                    let u = 1.0 - t;
                                    let bx = u * u * u * sx1
                                        + 3.0 * u * u * t * sc1x
                                        + 3.0 * u * t * t * sc2x
                                        + t * t * t * sx2;
                                    let by = u * u * u * sy1
                                        + 3.0 * u * u * t * sc1y
                                        + 3.0 * u * t * t * sc2y
                                        + t * t * t * sy2;
                                    paint_circle(
                                        bx,
                                        by,
                                        6.4 * zoom.sqrt(),
                                        rgba(0xa8824a30),
                                        window,
                                    );
                                    paint_circle(
                                        bx,
                                        by,
                                        3.2 * zoom.sqrt(),
                                        rgba(0xa8824aff),
                                        window,
                                    );
                                }
                            }

                            // 5. Crisp dashed squircle perimeters for Temporary Projects (`临时项目`)
                            for &(twx, twy, is_sel) in &temps_list {
                                let (tsx, tsy) = to_screen(twx, twy);
                                paint_squircle_outline(
                                    ox,
                                    oy,
                                    tsx,
                                    tsy,
                                    tile_world * zoom,
                                    true,
                                    if is_sel { 2.0 } else { 1.6 },
                                    if is_sel {
                                        rgba(0x17171aff)
                                    } else {
                                        rgba(0x8a877ecc)
                                    },
                                    window,
                                );
                            }
                        },
                    )
                    .size_full(),
                )
            },
        );

        let mut canvas_stage = div()
            .id("graph-infinite-stage")
            .relative()
            .flex_1()
            .size_full()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .bg(rgb(0xf8f7f3))
            .border_1()
            .border_color(colors::border())
            .rounded(layout::radius_card())
            .overflow_hidden()
            .cursor_grab()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, _, cx| {
                    this.graph_dragging = true;
                    this.graph_did_drag = false;
                    this.graph_drag_last = Some(ev.position);
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                if !this.graph_dragging || ev.pressed_button != Some(MouseButton::Left) {
                    return;
                }
                if let Some(prev) = this.graph_drag_last {
                    let dx = f32::from(ev.position.x - prev.x);
                    let dy = f32::from(ev.position.y - prev.y);
                    if dx.abs() > 1.5 || dy.abs() > 1.5 {
                        this.graph_did_drag = true;
                    }
                    let z = this.graph_zoom.clamp(0.45, 1.85);
                    this.graph_pan.0 += dx / z;
                    this.graph_pan.1 += dy / z;
                    this.graph_drag_last = Some(ev.position);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.graph_dragging = false;
                    this.graph_drag_last = None;
                    cx.notify();
                }),
            )
            .on_mouse_down_out(cx.listener(|this, _, _, _| {
                this.graph_dragging = false;
                this.graph_drag_last = None;
            }))
            .on_click(cx.listener(|this, ev: &ClickEvent, _, cx| {
                if this.graph_did_drag {
                    this.graph_did_drag = false;
                    return;
                }
                if ev.click_count() == 2 {
                    this.graph_pan = (0.0, 0.0);
                    this.graph_zoom = 1.0;
                } else {
                    this.graph_selected_kb_id = None;
                    this.graph_inspector_open = false;
                }
                cx.notify();
            }))
            // Trackpad (pixel deltas): two-finger swipe pans, pinch zooms — the macOS
            // Maps / Figma convention. Mouse wheel (line deltas) and ⌘/Ctrl+scroll zoom.
            .on_scroll(cx.listener(|this, ev: &ScrollEvent, _, cx| {
                let zoom_mod = ev.modifiers.platform || ev.modifiers.control;
                match ev.delta {
                    ScrollDelta::Pixels(d) if !zoom_mod => {
                        let (dx, dy) = (f32::from(d.x), f32::from(d.y));
                        if dx.abs() > 0.01 || dy.abs() > 0.01 {
                            let z = this.graph_zoom.clamp(0.45, 1.85);
                            this.graph_pan.0 += dx / z;
                            this.graph_pan.1 += dy / z;
                            cx.notify();
                        }
                    }
                    delta => {
                        let dy = match delta {
                            ScrollDelta::Pixels(d) => f32::from(d.y),
                            ScrollDelta::Lines(d) => d.y * 28.0,
                        };
                        if dy.abs() > 0.01 {
                            let factor = (1.0 + dy * 0.0022).clamp(0.82, 1.18);
                            this.graph_zoom = (this.graph_zoom * factor).clamp(0.45, 1.85);
                            cx.notify();
                        }
                    }
                }
            }))
            .on_pinch(cx.listener(|this, ev: &PinchEvent, _, cx| {
                if ev.delta.abs() > 0.0001 {
                    let factor = (1.0 + ev.delta).clamp(0.8, 1.25);
                    this.graph_zoom = (this.graph_zoom * factor).clamp(0.45, 1.85);
                    cx.notify();
                }
            }))
            .child(canvas_layer);

        // Layer 2: 100% Opaque Outward-Apex Relationship Pills (in open sky outside the orbit!)
        for e in &edges_for_pills {
            let pill_w = 68.0_f32;
            let pill_h = 22.0_f32;
            let badge_bg = if e.confirmed {
                rgb(0xffffff)
            } else {
                rgb(0xfcf6ea)
            };
            let badge_fg = if e.confirmed {
                colors::ink()
            } else {
                colors::gold()
            };
            let badge_border = if e.confirmed {
                colors::control_border()
            } else {
                rgb(0xe5d5bd)
            };

            canvas_stage = canvas_stage.child(
                div()
                    .absolute()
                    .left(relative(0.5))
                    .top(relative(0.5))
                    .ml(px((e.apex_x + pan.0) * zoom - pill_w * 0.5))
                    .mt(px((e.apex_y + pan.1) * zoom - pill_h * 0.5))
                    .w(px(pill_w))
                    .h(px(pill_h))
                    .rounded(layout::radius_pill())
                    .bg(badge_bg)
                    .border_1()
                    .border_color(badge_border)
                    .opacity(if e.dimmed { 0.35 } else { 1.0 })
                    .shadow(vec![BoxShadow {
                        inset: false,
                        color: hsla(0.0, 0.0, 0.09, 0.08),
                        offset: point(px(0.0), px(2.0)),
                        blur_radius: px(8.0),
                        spread_radius: px(0.0),
                    }])
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(10.5))
                    .font_weight(typography::WEIGHT_MEDIUM)
                    .text_color(badge_fg)
                    .child(e.label.clone()),
            );
        }

        // Layer 3: Center Obsidian Hub (`我` / Personal Global Rules) at world (0, 0)
        let hub_sz = hub_world * zoom;
        let hub_wrap_w = 150.0_f32;
        canvas_stage = canvas_stage.child(
            div()
                .id("graph-center-hub")
                .absolute()
                .left(relative(0.5))
                .top(relative(0.5))
                .w(px(hub_wrap_w))
                .ml(px(pan.0 * zoom - hub_wrap_w * 0.5))
                .mt(px(pan.1 * zoom - hub_sz * 0.5))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.0 * zoom.sqrt()))
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    this.graph_selected_kb_id = None;
                    this.graph_inspector_open = true;
                    cx.notify();
                }))
                .child(
                    div()
                        .size(px(hub_sz))
                        .rounded(layout::radius_pill())
                        .bg(colors::ink())
                        .border_2()
                        .border_color(colors::surface())
                        .shadow(vec![BoxShadow {
                            inset: false,
                            color: hsla(0.08, 0.16, 0.10, 0.20),
                            offset: point(px(0.0), px(6.0)),
                            blur_radius: px(20.0),
                            spread_radius: px(0.0),
                        }])
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(2.0))
                        .child(fuli_icon(
                            "shield",
                            (15.0 * zoom).clamp(11.0, 20.0),
                            colors::gold(),
                        ))
                        .child(
                            div()
                                .text_size(px((13.0 * zoom).clamp(10.0, 17.0)))
                                .font_weight(typography::WEIGHT_STRONG)
                                .text_color(colors::surface())
                                .child(tr(l, "我", "Me")),
                        ),
                )
                .child(
                    div()
                        .px(px(8.0))
                        .py(px(2.0))
                        .rounded(layout::radius_pill())
                        .bg(rgba(0xf8f7f3ee))
                        .text_size(px((11.0 * zoom.sqrt()).clamp(9.5, 13.0)))
                        .font_weight(typography::WEIGHT_MEDIUM)
                        .text_color(colors::muted())
                        .whitespace_nowrap()
                        .child(format!(
                            "{} · {}",
                            tr(l, "全局规矩", "Global"),
                            global_rule_count
                        )),
                ),
        );

        // Layer 4: Apple-Squircle Project Medallions + Unclipped Full Labels Below
        let is_related = |kb: &str| -> bool {
            let Some(sel) = selected_kb else {
                return true;
            };
            if sel == kb {
                return true;
            }
            active_links.iter().any(|lk| {
                (lk.from_kb_id == sel && lk.to_kb_id == kb)
                    || (lk.to_kb_id == sel && lk.from_kb_id == kb)
            })
        };

        let tile_sz = tile_world * zoom;
        let inner_sz = (tile_sz - 14.0 * zoom).max(24.0);
        let tile_r = tile_sz * 0.28;
        let inner_r = inner_sz * 0.25;
        let label_wrap_w = 176.0_f32;

        for (idx, n) in nodes.iter().enumerate() {
            let kb_sel = n.kb_id.clone();
            let is_sel = selected_kb == Some(n.kb_id.as_str());
            let related = is_related(&n.kb_id);
            let has_confirmed_link = active_links.iter().any(|lk| {
                lk.authority == LinkAuthority::HumanConfirmed
                    && (lk.from_kb_id == n.kb_id || lk.to_kb_id == n.kb_id)
            });
            let has_suggested_link = active_links.iter().any(|lk| {
                lk.authority == LinkAuthority::Suggested
                    && (lk.from_kb_id == n.kb_id || lk.to_kb_id == n.kb_id)
            });

            let (bg_hex, fg_hex) = if n.is_temp {
                (0xf2efe8, 0x7a766d)
            } else {
                squircle_palette_for(&n.name)
            };
            let monogram = squircle_monogram(&n.name);

            let mut squircle = div()
                .size(px(tile_sz))
                .rounded(px(tile_r))
                .relative()
                .flex()
                .items_center()
                .justify_center();

            if n.is_temp {
                // Dashed outline is painted crisply by the Canvas layer; keep interior calm translucent parchment
                squircle = squircle
                    .bg(rgba(0xf8f7f3c8))
                    .child(
                        div()
                            .size(px(inner_sz))
                            .rounded(px(inner_r))
                            .bg(rgba(0xeeebe3b8))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px((16.0 * zoom).clamp(11.0, 22.0)))
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(rgb(fg_hex))
                            .child(monogram),
                    )
                    .child(
                        div()
                            .absolute()
                            .top(px(-6.0))
                            .right(px(-6.0))
                            .px(px(5.0))
                            .py(px(1.0))
                            .rounded(layout::radius_pill())
                            .bg(rgb(0xf4f1ea))
                            .border_1()
                            .border_color(colors::control_border())
                            .text_size(px(9.5))
                            .font_weight(typography::WEIGHT_MEDIUM)
                            .text_color(colors::muted())
                            .child(tr(l, "临时", "Temp")),
                    );
            } else {
                squircle = squircle
                    .bg(colors::surface())
                    .border_1()
                    .border_color(if is_sel {
                        colors::ink()
                    } else if has_confirmed_link {
                        rgb(0xd4cfc2)
                    } else {
                        colors::border()
                    })
                    .shadow(vec![BoxShadow {
                        inset: false,
                        color: hsla(0.08, 0.14, 0.12, if is_sel { 0.18 } else { 0.08 }),
                        offset: point(px(0.0), px(if is_sel { 7.0 } else { 4.0 })),
                        blur_radius: px(if is_sel { 20.0 } else { 12.0 }),
                        spread_radius: px(0.0),
                    }])
                    .child(
                        div()
                            .size(px(inner_sz))
                            .rounded(px(inner_r))
                            .bg(rgb(bg_hex))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px((17.0 * zoom).clamp(11.0, 24.0)))
                            .font_weight(typography::WEIGHT_STRONG)
                            .text_color(rgb(fg_hex))
                            .child(monogram),
                    );

                if has_confirmed_link || has_suggested_link {
                    let dot_sz = (10.0 * zoom.sqrt()).clamp(7.0, 12.0);
                    squircle = squircle.child(
                        div()
                            .absolute()
                            .top(px(5.0 * zoom.sqrt()))
                            .right(px(5.0 * zoom.sqrt()))
                            .size(px(dot_sz))
                            .rounded(layout::radius_pill())
                            .bg(if has_confirmed_link {
                                colors::success()
                            } else {
                                colors::gold()
                            })
                            .border_2()
                            .border_color(colors::surface()),
                    );
                }
            }

            let node_wrap = div()
                .id(format!("gnode-sq-{idx}"))
                .absolute()
                .left(relative(0.5))
                .top(relative(0.5))
                .w(px(label_wrap_w))
                .ml(px((n.wx + pan.0) * zoom - label_wrap_w * 0.5))
                .mt(px((n.wy + pan.1) * zoom - tile_sz * 0.5))
                .opacity(if related { 1.0 } else { 0.50 })
                .flex()
                .flex_col()
                .items_center()
                .gap(px(6.0 * zoom.sqrt()))
                .cursor_pointer()
                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.graph_selected_kb_id = Some(kb_sel.clone());
                    this.graph_inspector_open = true;
                    cx.notify();
                }))
                .child(squircle)
                .child(
                    div()
                        .px(px(8.0))
                        .py(px(2.0))
                        .rounded(px(7.0))
                        .bg(rgba(0xf8f7f3eb))
                        .flex()
                        .flex_col()
                        .items_center()
                        .child(
                            div()
                                .text_size(px((12.5 * zoom.sqrt()).clamp(10.0, 15.0)))
                                .font_weight(if n.is_temp {
                                    typography::WEIGHT_MEDIUM
                                } else {
                                    typography::WEIGHT_STRONG
                                })
                                .text_color(if n.is_temp {
                                    colors::muted()
                                } else {
                                    colors::ink()
                                })
                                .whitespace_nowrap()
                                .child(n.name.clone()),
                        )
                        .child(
                            div()
                                .text_size(px((10.5 * zoom.sqrt()).clamp(9.0, 12.5)))
                                .text_color(colors::muted())
                                .whitespace_nowrap()
                                .child(if n.is_temp {
                                    format!("{} {}", n.item_count, tr(l, "条临时会话", "sessions"))
                                } else {
                                    format!(
                                        "{} {} · {} {}",
                                        n.item_count,
                                        tr(l, "知识", "items"),
                                        n.rule_count,
                                        tr(l, "规矩", "rules")
                                    )
                                }),
                        ),
                );

            canvas_stage = canvas_stage.child(node_wrap);
        }

        // Layer 5: Floating Corner Frosted Glass HUD (Top-Left Legend + Top-Right Inspector Toggle + Bottom-Right Zoom)
        let top_left_hud = div()
            .absolute()
            .top(px(16.0))
            .left(px(16.0))
            .px(px(14.0))
            .py(px(9.0))
            .rounded(layout::radius_card())
            .bg(rgba(0xffffffea))
            .border_1()
            .border_color(colors::border())
            .shadow(vec![BoxShadow {
                inset: false,
                color: hsla(0.0, 0.0, 0.09, 0.06),
                offset: point(px(0.0), px(4.0)),
                blur_radius: px(14.0),
                spread_radius: px(0.0),
            }])
            .flex()
            .items_center()
            .gap(px(12.0))
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                div()
                    .text_size(typography::card_title_size())
                    .font_weight(typography::WEIGHT_STRONG)
                    .text_color(colors::ink())
                    .child(tr(l, "关系图谱", "Relationship Map")),
            )
            .child(div().w(px(1.0)).h(px(14.0)).bg(colors::border()))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .text_size(px(11.0))
                    .text_color(colors::muted())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .child(div().w(px(12.0)).h(px(2.0)).bg(colors::ink()))
                            .child(tr(l, "已授权", "Shared")),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .child(div().w(px(12.0)).h(px(2.0)).bg(colors::gold()))
                            .child(tr(l, "待拍板", "Pending")),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.0))
                            .child(
                                div()
                                    .size(px(10.0))
                                    .rounded(px(3.0))
                                    .border_1()
                                    .border_dashed()
                                    .border_color(colors::muted()),
                            )
                            .child(tr(l, "虚框=临时项目", "Dashed=Temp")),
                    ),
            );

        let top_right_hud = div()
            .absolute()
            .top(px(16.0))
            .right(px(16.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                secondary_button(
                    "graph-toggle-inspector",
                    format!(
                        "{} ({})",
                        tr(l, "关联与详情", "Links & Details"),
                        active_links.len()
                    ),
                    ControlSize::Sm,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    cx.stop_propagation();
                    this.graph_inspector_open = !this.graph_inspector_open;
                    cx.notify();
                })),
            );

        let zoom_pct = (zoom * 100.0).round() as i32;
        let zoom_hud = div()
            .absolute()
            .bottom(px(18.0))
            .right(px(18.0))
            .px(px(6.0))
            .py(px(5.0))
            .rounded(layout::radius_pill())
            .bg(rgba(0xffffffef))
            .border_1()
            .border_color(colors::border())
            .shadow(vec![BoxShadow {
                inset: false,
                color: hsla(0.08, 0.12, 0.12, 0.10),
                offset: point(px(0.0), px(6.0)),
                blur_radius: px(18.0),
                spread_radius: px(0.0),
            }])
            .flex()
            .items_center()
            .gap(px(4.0))
            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                cx.stop_propagation();
            })
            .child(
                div()
                    .id("graph-zoom-out")
                    .size(px(28.0))
                    .rounded(layout::radius_pill())
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_size(px(15.0))
                    .text_color(colors::ink())
                    .hover(|s| s.bg(colors::hover()))
                    .active(|s| s.bg(rgb(0xe4e1d8)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.graph_zoom = (this.graph_zoom * 0.85).clamp(0.45, 1.85);
                        cx.notify();
                    }))
                    .child("−"),
            )
            .child(
                div()
                    .id("graph-zoom-reset")
                    .h(px(28.0))
                    .px(px(8.0))
                    .rounded(layout::radius_pill())
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_size(typography::meta_size())
                    .font_weight(typography::WEIGHT_MEDIUM)
                    .text_color(colors::muted())
                    .hover(|s| s.bg(colors::hover()).text_color(colors::ink()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.graph_pan = (0.0, 0.0);
                        this.graph_zoom = 1.0;
                        cx.notify();
                    }))
                    .child(format!("{zoom_pct}%")),
            )
            .child(
                div()
                    .id("graph-zoom-in")
                    .size(px(28.0))
                    .rounded(layout::radius_pill())
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_size(px(15.0))
                    .text_color(colors::ink())
                    .hover(|s| s.bg(colors::hover()))
                    .active(|s| s.bg(rgb(0xe4e1d8)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.graph_zoom = (this.graph_zoom * 1.18).clamp(0.45, 1.85);
                        cx.notify();
                    }))
                    .child("+"),
            )
            .child(
                div()
                    .w(px(1.0))
                    .h(px(14.0))
                    .mx(px(2.0))
                    .bg(colors::border()),
            )
            .child(
                div()
                    .id("graph-fit-btn")
                    .h(px(28.0))
                    .px(px(10.0))
                    .rounded(layout::radius_pill())
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_size(typography::meta_size())
                    .font_weight(typography::WEIGHT_MEDIUM)
                    .text_color(colors::ink())
                    .hover(|s| s.bg(colors::hover()))
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.graph_pan = (0.0, 0.0);
                        this.graph_zoom = 1.0;
                        cx.notify();
                    }))
                    .child(tr(l, "居中", "Fit")),
            );

        canvas_stage = canvas_stage
            .child(top_left_hud)
            .child(top_right_hud)
            .child(zoom_hud);

        // Layer 6: On-Demand Floating Right Frosted Inspector Card (only when a node or `关联与详情` is clicked!)
        if self.graph_inspector_open {
            let selected_node = nodes
                .iter()
                .find(|n| self.graph_selected_kb_id.as_deref() == Some(n.kb_id.as_str()));

            let mut right_col = div().flex().flex_col().gap(px(12.0)).pb(px(12.0));

            if let Some(sn) = selected_node {
                let jump_aid = sn.agent_id.clone();
                let jump_kid = sn.kb_id.clone();
                let is_temp = sn.is_temp;

                let mut header_actions = div().flex().items_center().gap(px(6.0));
                if !is_temp {
                    header_actions = header_actions.child(
                        secondary_button(
                            "graph-jump-agent",
                            tr(l, "打开工作台 ›", "Workbench ›"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.selected_agent_id = Some(jump_aid.clone());
                            this.selected_kb_id = Some(jump_kid.clone());
                            this.switch_tab(NavTab::Agents, cx);
                        })),
                    );
                }

                right_col = right_col.child(
                    section_card()
                        .p(px(16.0))
                        .child(section_header(
                            sn.name.clone(),
                            Some(header_actions.into_any_element()),
                        ))
                        .child(
                            div()
                                .text_size(typography::meta_size())
                                .text_color(colors::muted())
                                .child(if sn.description.is_empty() {
                                    tr(
                                        l,
                                        "拖动空白画布可平移，滚轮可放大缩小，双击画布回到居中。",
                                        "Drag canvas to pan, scroll to zoom, double-click to reset.",
                                    )
                                    .to_string()
                                } else {
                                    sn.description.clone()
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .gap(px(8.0))
                                .child(stat_tile(
                                    sn.item_count.to_string(),
                                    if is_temp {
                                        tr(l, "条临时会话", "Temp Sessions")
                                    } else {
                                        tr(l, "条专属知识", "KB Items")
                                    },
                                    if is_temp {
                                        tr(l, "不污染正式项目", "Isolated sandbox")
                                    } else {
                                        tr(l, "本库直接命中", "Direct 0-hop")
                                    },
                                ))
                                .child(stat_tile(
                                    sn.rule_count.to_string(),
                                    tr(l, "条项目规矩", "Project Rules"),
                                    format!("+{} {}", global_rule_count, tr(l, "全局", "global")),
                                )),
                        ),
                );
            }

            let mut links_card = section_card().p(px(16.0)).child(section_header(
                tr(l, "跨项目关联", "Cross-Project Links"),
                Some(
                    status_badge(format!("{}", active_links.len()), BadgeTone::Neutral)
                        .into_any_element(),
                ),
            ));

            if active_links.is_empty() {
                links_card = links_card.child(empty_state(
                    tr(l, "还没有建立项目连线", "No project links yet"),
                    tr(
                        l,
                        "在「记忆 → 知识库」打开跨库引用后，这里会自动画出来。",
                        "Enable cross-KB links in Memory to see them here.",
                    ),
                ));
            } else {
                for (idx, lk) in active_links.iter().enumerate() {
                    let from_name = data
                        .knowledge_bases
                        .iter()
                        .find(|k| k.id == lk.from_kb_id)
                        .map(|k| k.name.replace(" 知识库", ""))
                        .unwrap_or_else(|| lk.from_kb_id.clone());
                    let to_name = data
                        .knowledge_bases
                        .iter()
                        .find(|k| k.id == lk.to_kb_id)
                        .map(|k| k.name.replace(" 知识库", ""))
                        .unwrap_or_else(|| lk.to_kb_id.clone());
                    let rel_label = match lk.relation_type {
                        KbLinkType::Cites => tr(l, "引用", "cites"),
                        KbLinkType::Inherits => tr(l, "继承", "inherits"),
                    };
                    let is_confirmed = lk.authority == LinkAuthority::HumanConfirmed;
                    let from_id = lk.from_kb_id.clone();
                    let to_id = lk.to_kb_id.clone();
                    let rel_str = lk.relation_type.as_str().to_string();
                    let from_id_rm = from_id.clone();
                    let to_id_rm = to_id.clone();
                    let rel_str_rm = rel_str.clone();

                    let mut btn_row = div().flex().gap(px(6.0));
                    if !is_confirmed {
                        btn_row = btn_row.child(
                            primary_button(
                                format!("glk-ok-{idx}"),
                                tr(l, "确认打通", "Confirm"),
                                ControlSize::Sm,
                            )
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.run_action(
                                        "set_kb_link",
                                        json!({
                                            "from_kb_id": from_id,
                                            "to_kb_id": to_id,
                                            "relation_type": rel_str,
                                            "authority": "human_confirmed",
                                            "rationale": "在关系图谱中确认打通跨库引用"
                                        }),
                                        "已确认项目关联，实线生效",
                                        cx,
                                    );
                                },
                            )),
                        );
                    }
                    btn_row = btn_row.child(
                        secondary_button(
                            format!("glk-rm-{idx}"),
                            tr(l, "断开", "Disconnect"),
                            ControlSize::Sm,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.run_action(
                                "set_kb_link",
                                json!({
                                    "from_kb_id": from_id_rm,
                                    "to_kb_id": to_id_rm,
                                    "relation_type": rel_str_rm,
                                    "authority": "revoked",
                                    "rationale": "在关系图谱中断开关联"
                                }),
                                "已断开该条关联",
                                cx,
                            );
                        })),
                    );

                    links_card = links_card.child(
                        inset_panel()
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap(px(8.0))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w(px(0.0))
                                            .text_size(typography::control_size())
                                            .font_weight(typography::WEIGHT_MEDIUM)
                                            .child(format!(
                                                "{from_name} → {to_name} ({rel_label})"
                                            )),
                                    )
                                    .child(status_badge(
                                        if is_confirmed {
                                            tr(l, "已授权", "Shared")
                                        } else {
                                            tr(l, "待拍板", "Pending")
                                        },
                                        if is_confirmed {
                                            BadgeTone::Success
                                        } else {
                                            BadgeTone::Gold
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .text_size(typography::meta_size())
                                    .text_color(colors::muted())
                                    .child(lk.rationale.clone()),
                            )
                            .child(btn_row),
                    );
                }
            }

            right_col = right_col.child(links_card);

            let inspector_panel = div()
                .w(px(352.0))
                .h_full()
                .bg(rgba(0xfafaf6f4))
                .border_1()
                .border_color(colors::border())
                .rounded(layout::radius_card())
                .p(px(14.0))
                .shadow(vec![BoxShadow {
                    inset: false,
                    color: hsla(0.08, 0.14, 0.10, 0.14),
                    offset: point(px(-4.0), px(8.0)),
                    blur_radius: px(28.0),
                    spread_radius: px(0.0),
                }])
                .flex()
                .flex_col()
                .gap(px(10.0))
                .on_mouse_down(MouseButton::Left, |_, _, cx| {
                    cx.stop_propagation();
                })
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(typography::control_size())
                                .font_weight(typography::WEIGHT_STRONG)
                                .text_color(colors::ink())
                                .child(tr(l, "节点与关联详情", "Inspector")),
                        )
                        .child(
                            top_icon_button("graph-inspector-close", "x", false).on_click(
                                cx.listener(|this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.graph_inspector_open = false;
                                    cx.notify();
                                }),
                            ),
                        ),
                )
                .child(scroll_area("graph-floating-inspector-scroll", right_col));

            canvas_stage = canvas_stage.child(
                div()
                    .absolute()
                    .top(px(58.0))
                    .right(px(16.0))
                    .bottom(px(62.0))
                    .child(spring_entrance(
                        "graph-inspector-spring",
                        26.0,
                        0.0,
                        inspector_panel.into_any_element(),
                    )),
            );
        }

        div()
            .flex_1()
            .size_full()
            .min_w(px(0.0))
            .min_h(px(0.0))
            .flex()
            .flex_col()
            .child(canvas_stage)
    }
}
