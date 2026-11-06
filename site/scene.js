// Scroll-driven 3D story: twelve fragments scatter, assemble into one Agent,
// then regroup to walk through the product. Positions are in the rig's own space.
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

const materials = ["jade","silver","silver","jade","silver","carbon","silver","silver","jade","silver","carbon","silver"];
const icons = [
  "M16 8a4 4 0 1 1-8 0a4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  "M3 7h7l2 3h9v10H3z",
  "M4 4h16v12H9l-5 4zM8 8h8M8 12h5",
  "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z",
];
// The order the page tells it: what FULI is, tokens and recall, what it keeps (沉淀), projects,
// your FLA, how an FLA grows, what it grows (Workbench, Workflow, Agent App), the built-in roles,
// the round table, this computer.
const sceneNames = ["scatter", "memory", "knowledge", "projects", "owner", "growth", "workbench", "team", "roundtable", "database"];
// Night scenes; the database scene also shifts the object left to make room for its layer notes.
const darkScenes = new Set(["roundtable", "database"]);
// Rig orientation per scene: rotateX, rotateY, rotateZ, scale.
const views = [
  [48, -10, -25, 0.9],
  [36, -12, -10, 1.04],
  [40, -10, -16, 1],
  [40, -10, -16, 1],
  [52, -8, -26, 1.12],
  [58, -6, -30, 1],
  [38, 0, -8, 1],
  [14, -4, 0, 1.06],
  [62, 0, 0, 0.92],
  [57, 0, -24, 0.85],
];

function createFragment([title, detail], index) {
  const item = document.createElement("div");
  item.className = `fragment fragment-${materials[index]}`;
  const face = document.createElement("div");
  face.className = "fragment-face fragment-front";
  // Static illustration text only; nothing user-supplied reaches innerHTML.
  face.innerHTML = `<div class="fragment-heading"><span>${title}</span><svg viewBox="0 0 24 24"><path d="${icons[index % icons.length]}"/></svg></div><div class="fragment-lines"><i></i><i></i><i></i></div><span class="fragment-detail">${detail}</span>`;
  item.append(face);
  for (const side of ["back", "top", "bottom", "left", "right"]) {
    const surface = document.createElement("div");
    surface.className = `fragment-face fragment-${side}`;
    item.append(surface);
  }
  return item;
}

// Each pose: x, y, z, rotateX, rotateY, rotateZ, scale, opacity.
const poses = {
  scatter: (i) => [...[
    [-185, -112, 135, -12, 8, -9], [73, -125, 60, 8, -13, 7], [-212, 38, 18, 8, -12, -9],
    [89, 28, 118, -7, 8, 6], [-96, -2, -68, -8, 11, -5], [205, -24, -42, 11, 8, 12],
    [-220, 185, -42, 5, 17, 4], [105, 197, 8, -6, -7, -7], [-18, 151, 160, -12, 5, 5],
    [215, 143, -105, 12, 6, 7], [-54, -181, -100, 7, -15, -8], [220, -173, 94, -5, 10, 10],
  ][i], 0.88, 1],
  // One Agent: the pieces lock into a single layered block.
  owner: (i) => {
    const column = i % 2, row = Math.floor(i / 2) % 2, layer = Math.floor(i / 4);
    return [(column - 0.5) * 184, (row - 0.5) * 120, (layer - 1) * 25, 0, 0, 0, 1, 1];
  },
  // Titles first, bodies when needed: four open pieces beside one folded index stack.
  memory: (i) => {
    if (i < 4) return [-150 + ((i % 2) - 0.5) * 106, -14 + (Math.floor(i / 2) - 0.5) * 76, (3 - i) * 10, 0, -8, -4, 0.56, 1];
    return [158 + (i - 4) * 2, 18 + (i - 4) * 4, -(i - 4) * 20, 0, 0, 0, 0.64, mix(1, 0.35, (i - 4) / 7)];
  },
  // Drawn or shown chapters (growth.css, screens.css): the pieces gather behind and fade.
  growth: () => [0, 20, -60, 0, 0, 0, 0.3, 0],
  knowledge: () => [0, 20, -60, 0, 0, 0, 0.3, 0],
  projects: () => [0, 20, -60, 0, 0, 0, 0.3, 0],
  // What it grows: three columns, Workbench cards, a Workflow chain, Agent Apps.
  workbench: (i) => {
    const column = Math.floor(i / 4), row = i % 4;
    const chain = column === 1 ? (row % 2 ? 22 : -22) : 0;
    return [(column - 1) * 210 + chain, (row - 1.5) * 76, column === 2 ? row * 14 : 0, 0, 0, column === 1 ? (row % 2 ? 3 : -3) : 0, 0.54, 1];
  },
  // Four built-in roles support the project lead; project members report to the lead.
  team: (i) => {
    if (i < 8) {
      const role = Math.floor(i / 2) - 1.5, j = i % 2;
      return [role * 168 + j * 7, -150 + j * 8, -j * 18, 0, 0, role * 2, 0.52, j ? 0.78 : 1];
    }
    if (i === 8) return [0, 18, 24, 0, 0, 0, 0.64, 1];
    return [(i - 10) * 150, 196, 0, 0, 0, (i - 10) * 3, 0.48, 1];
  },
  // The round table: every piece is a seat facing the centre.
  roundtable: (i) => {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * 238, Math.sin(angle) * 238, 0, 0, 0, (angle * 180) / Math.PI + 90, 0.56, 1];
  },
  // This computer: four horizontal layers, clients on top, Neo4j at the bottom.
  database: (i) => [((i % 3) - 1) * 134, 0, (Math.floor(i / 3) - 1.5) * 112, 0, 0, 0, 0.72, 1],
};
const pose = (scene, i) => poses[sceneNames[scene]](i);

function blendColor(a, b, t) {
  return `rgb(${a.map((value, i) => Math.round(mix(value, b[i], t))).join(" ")})`;
}

export function createScrollScene({ labels }) {
  const journey = document.querySelector(".journey");
  const rig = document.querySelector("#fragment-rig");
  const stage = document.querySelector(".spatial-stage");
  const chapters = [...document.querySelectorAll(".chapter")];
  const nav = document.querySelector(".chapter-nav");
  const dots = [...nav.querySelectorAll("a")];
  const overlays = [...document.querySelectorAll("[data-overlay]")];
  // Some chapters are drawn or shown, not built from pieces: their overlay is a copy of the
  // chapter's own figure, which stays as the reduced-motion version.
  for (const overlay of overlays) {
    const figure = overlay.dataset.copy && !overlay.firstElementChild ? document.querySelector(overlay.dataset.copy) : null;
    if (!figure) continue;
    const copy = figure.cloneNode(true);
    copy.classList.remove("static-figure");
    copy.removeAttribute("aria-label");
    copy.removeAttribute("data-i18n-aria-label");
    copy.querySelectorAll(".is-static").forEach((frame) => frame.classList.remove("is-static"));
    overlay.append(copy);
  }
  const growthIndex = sceneNames.indexOf("growth");
  const growthArt = document.querySelector('[data-overlay="growth"] .ga-stage');
  const growthOverlays = [...document.querySelectorAll('[data-overlay="growth"]')];
  // Overlays that play along their chapter's dwell read it as --scene-progress (0 → 1).
  const progressOverlays = overlays.filter((overlay) => overlay.hasAttribute("data-progress"))
    .map((overlay) => ({ overlay, scene: sceneNames.indexOf(overlay.dataset.overlay) }));
  // A shown chapter with several screens moves to the next one partway through its dwell.
  const screens = overlays.filter((overlay) => overlay.querySelector(".app-frame"))
    .map((overlay) => ({ scene: sceneNames.indexOf(overlay.dataset.overlay), frames: [...overlay.querySelectorAll(".app-frame")] }));
  const header = document.querySelector(".nav");
  const progress = document.querySelector(".story-progress");
  const cue = document.querySelector(".scroll-cue");
  const pieces = labels('default').map(createFragment);
  pieces.forEach((piece) => rig.append(piece));

  let enabled = false, scheduled = false, positions = [], heights = [], active = -1;

  function measure() {
    positions = chapters.map((chapter) => chapter.getBoundingClientRect().top + window.scrollY);
    heights = chapters.map((chapter) => chapter.offsetHeight);
    schedule();
  }

  function render() {
    scheduled = false;
    if (!enabled) return;
    const y = window.scrollY;
    // Each chapter dwells for its first ~43%, then morphs into the next scene.
    let index = 0;
    while (index < positions.length - 1 && y >= positions[index + 1]) index++;
    const length = (positions[index + 1] ?? positions[index] + heights[index]) - positions[index];
    const local = clamp((y - positions[index]) / length);
    const next = Math.min(index + 1, sceneNames.length - 1);
    const t = smooth(clamp((local - 0.43) / 0.48));
    // The drawing plays while its chapter dwells, before the morph to the next scene.
    // The scroll arrow fades out over the first third of the first screen.
    if (cue) cue.style.opacity = String(1 - clamp(y / (window.innerHeight / 3)));
    // The card plays over the first quarter of the chapter; then FLAs fill the stage.
    const growth = index === growthIndex ? clamp(local / 0.26) : index > growthIndex ? 1 : 0;
    const finale = index === growthIndex ? clamp((local - 0.28) / 0.13) : index > growthIndex ? 1 : 0;
    growthArt?.style.setProperty("--growth-progress", growth.toFixed(3));
    for (const overlay of growthOverlays) overlay.style.setProperty("--growth-finale", finale.toFixed(3));
    for (const { overlay, scene } of progressOverlays) {
      const played = scene === index ? clamp(local / 0.43) : scene < index ? 1 : 0;
      overlay.style.setProperty("--scene-progress", played.toFixed(3));
    }
    for (const { scene, frames } of screens) {
      const shown = scene === index ? Math.min(frames.length - 1, Math.floor(clamp(local / 0.42) * frames.length)) : scene < index ? frames.length - 1 : 0;
      frames.forEach((frame, i) => frame.classList.toggle("is-current", i === shown));
    }
    const darkness = (scene) => (darkScenes.has(sceneNames[scene]) ? 1 : 0);
    const dark = mix(darkness(index), darkness(next), t);
    const database = mix(sceneNames[index] === "database" ? 1 : 0, sceneNames[next] === "database" ? 1 : 0, t);
    const narrow = window.innerWidth <= 700;
    const stacked = window.innerWidth <= 1050;
    const storyLeft = narrow ? 50 : index === 0 ? mix(72, 68, t) : 68;
    // On a phone the hero's copy and downloads take more height, so its pieces start lower.
    const storyTop = narrow ? (index === 0 ? mix(76, 69, t) : 69) : 52;
    stage.style.setProperty("--rig-left", `${mix(storyLeft, narrow ? 25 : stacked ? 32 : 58, database)}%`);
    stage.style.setProperty("--rig-top", `${mix(storyTop, narrow ? 70 : stacked ? 68 : 52, database)}%`);
    stage.style.setProperty("--scene-background", blendColor([246, 245, 241], [17, 23, 24], dark));
    stage.style.setProperty("--scene-label", blendColor([45, 73, 60], [210, 231, 219], dark));
    stage.style.setProperty("--atmosphere-opacity", String(1 - dark * 0.8));
    header?.classList.toggle("is-dark", dark > 0.5);
    stage.style.setProperty("--shadow-opacity", String(0.6 - dark * 0.5));
    stage.style.setProperty("--word-opacity", String(index === 0 ? (1 - t) * 0.85 : 0));
    stage.style.setProperty("--mobile-scale", String(index === 0 ? mix(0.57, 0.66, t) : 0.66));
    journey.style.setProperty("--chapter-ink", blendColor([27, 31, 29], [245, 245, 247], dark));
    journey.style.setProperty("--chapter-soft", blendColor([58, 64, 60], [186, 196, 195], dark));

    const sceneView = scene => sceneNames[scene] === "database" && narrow ? [57, 0, -24, 0.6] : views[scene];
    const view = sceneView(index).map((value, j) => mix(value, sceneView(next)[j], t));
    rig.style.transform = `rotateX(${view[0]}deg) rotateY(${view[1]}deg) rotateZ(${view[2]}deg) scale(${view[3]})`;
    pieces.forEach((piece, i) => {
      const a = pose(index, i), b = pose(next, i);
      const v = a.map((value, j) => mix(value, b[j], t));
      piece.style.transform = `translate3d(${v[0]}px,${v[1]}px,${v[2]}px) rotateX(${v[3]}deg) rotateY(${v[4]}deg) rotateZ(${v[5]}deg) scale(${v[6]})`;
      piece.style.opacity = String(v[7]);
    });

    chapters.forEach((chapter, i) => {
      const distance = y - positions[i];
      const fadeIn = i === 0 ? 1 : clamp((distance + window.innerHeight * 0.28) / (window.innerHeight * 0.25));
      const fadeOut = 1 - clamp((distance - heights[i] * 0.56) / (heights[i] * 0.28));
      chapter.style.setProperty("--copy-opacity", String(Math.min(fadeIn, fadeOut)));
      chapter.style.setProperty("--copy-y", `${mix(22, 0, smooth(fadeIn))}px`);
    });
    overlays.forEach((overlay) => {
      const scene = sceneNames.indexOf(overlay.dataset.overlay);
      const opacity = scene === index ? 1 - t : scene === next ? t : 0;
      overlay.classList.toggle("is-active", opacity > 0.01);
      overlay.style.opacity = String(opacity);
      if (opacity > 0.01) attach(overlay);
    });

    const current = t > 0.5 ? next : index;
    if (current !== active) {
      active = current;
      const currentLabels = labels(sceneNames[current]);
      pieces.forEach((piece, i) => {
        const [title, detail] = currentLabels[i];
        piece.querySelector(".fragment-heading>span").textContent = title;
        piece.querySelector(".fragment-detail").textContent = detail;
      });
      stage.dataset.scene = sceneNames[current];
      dots.forEach((dot, i) => {
        if (i === current) dot.setAttribute("aria-current", "step");
        else dot.removeAttribute("aria-current");
      });
    }
    const end = journey.offsetTop + journey.offsetHeight - window.innerHeight;
    nav.hidden = y > end + window.innerHeight * 0.4;
    // How far through the story: one thin line under the header, scaled on the compositor.
    progress.hidden = nav.hidden;
    progress.style.setProperty("--story-progress", String(clamp((y - journey.offsetTop) / Math.max(1, end - journey.offsetTop))));
  }

  // Labels and connector lines follow the projected cards, so they stay aligned at any size.
  function attach(overlay) {
    const bounds = stage.getBoundingClientRect();
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left - bounds.left, right: r.right - bounds.left, top: r.top - bounds.top,
        bottom: r.bottom - bounds.top, x: (r.left + r.right) / 2 - bounds.left, y: (r.top + r.bottom) / 2 - bounds.top };
    };
    for (const label of overlay.querySelectorAll("[data-anchor]")) {
      const piece = box(pieces[Number(label.dataset.anchor)]);
      const place = label.dataset.place ?? "above";
      label.style.left = `${place === "right" ? piece.right + 14 : piece.x}px`;
      label.style.top = `${place === "below" ? piece.bottom + 14 : place === "right" ? piece.y : piece.top - 14}px`;
    }
    for (const path of overlay.querySelectorAll("path[data-from]")) {
      const from = box(pieces[Number(path.dataset.from)]);
      if (path.dataset.toNote) {
        const note = box(overlay.querySelector(path.dataset.toNote));
        const end = note.left - 10, elbow = end - 16;
        path.setAttribute("d", `M${from.right + 4} ${from.y} H${elbow} V${note.y} H${end}`);
      } else {
        const to = box(pieces[Number(path.dataset.to)]);
        const startY = from.bottom + 4, endY = to.top - 4, middle = (startY + endY) / 2;
        path.setAttribute("d", `M${from.x} ${startY} C${from.x} ${middle} ${to.x} ${middle} ${to.x} ${endY}`);
      }
    }
  }

  function schedule() {
    if (enabled && !scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }

  new ResizeObserver(measure).observe(journey);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", measure, { passive: true });
  document.fonts?.ready.then(measure);

  return {
    refresh() {
      active = -1;
      measure();
    },
    setEnabled(value) {
      enabled = value;
      document.body.classList.toggle("enhanced", value);
      nav.hidden = !value;
      progress.hidden = !value;
      if (value) measure();
      else {
        header?.classList.remove("is-dark");
        journey.style.removeProperty("--chapter-ink");
        journey.style.removeProperty("--chapter-soft");
      }
    },
  };
}
