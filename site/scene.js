// Scroll-driven 3D story: twelve fragments scatter, assemble into one Agent,
// then regroup to explain each idea. Positions are in the rig's own space.
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
const sceneNames = ["scatter", "owner", "handoff", "roundtable", "taste", "team", "memory", "database"];
// Night scenes; the database scene also shifts the object left to make room for its layer notes.
const darkScenes = new Set(["roundtable", "database"]);
// Rig orientation per scene: rotateX, rotateY, rotateZ, scale.
const views = [
  [48, -10, -25, 0.9],
  [52, -8, -26, 1.12],
  [30, -8, -6, 1.02],
  [62, 0, 0, 0.92],
  [56, -14, -30, 1],
  [14, -4, 0, 1.06],
  [36, -12, -10, 1.04],
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
function pose(scene, i) {
  if (scene === 0) {
    return [...[
      [-185, -112, 135, -12, 8, -9], [73, -125, 60, 8, -13, 7], [-212, 38, 18, 8, -12, -9],
      [89, 28, 118, -7, 8, 6], [-96, -2, -68, -8, 11, -5], [205, -24, -42, 11, 8, 12],
      [-220, 185, -42, 5, 17, 4], [105, 197, 8, -6, -7, -7], [-18, 151, 160, -12, 5, 5],
      [215, 143, -105, 12, 6, 7], [-54, -181, -100, 7, -15, -8], [220, -173, 94, -5, 10, 10],
    ][i], 0.88, 1];
  }
  if (scene === 1) {
    // One Agent: the pieces lock into a single layered block.
    const column = i % 2, row = Math.floor(i / 2) % 2, layer = Math.floor(i / 4);
    return [(column - 0.5) * 184, (row - 0.5) * 120, (layer - 1) * 25, 0, 0, 0, 1, 1];
  }
  if (scene === 2) {
    // Two clients around one identity: the centre stack stays, the sides swap.
    const group = Math.floor(i / 4), j = i % 4;
    const center = [[-205, 0], [0, 0], [205, 0]][group];
    if (group === 1) return [0, 0, 18 + j * 22, 0, 0, 0, 0.78, 1];
    return [center[0] + ((j % 2) - 0.5) * 76, center[1] + (Math.floor(j / 2) - 0.5) * 62, j * 6, 0, 0, group ? 6 : -6, 0.42, 0.9];
  }
  if (scene === 3) {
    // The round table: every piece is a seat facing the centre.
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * 238, Math.sin(angle) * 238, 0, 0, 0, (angle * 180) / Math.PI + 90, 0.56, 1];
  }
  if (scene === 4) {
    // Two layers: personal-global underneath, the project layer floating above.
    if (i < 8) return [((i % 4) - 1.5) * 128, (Math.floor(i / 4) - 0.5) * 86, -36, 0, 0, 0, 0.66, 0.92];
    const j = i - 8;
    return [70 + ((j % 2) - 0.5) * 128, -30 + (Math.floor(j / 2) - 0.5) * 86, 120, 0, 0, 0, 0.66, 1];
  }
  if (scene === 5) {
    // Three peer specialists support the project lead; project members report to the lead.
    if (i < 9) {
      const column = Math.floor(i / 3) - 1, j = i % 3;
      return [column * 192 + j * 7, -150 + j * 8, -j * 18, 0, 0, column * 3, 0.56, j ? 0.8 - j * 0.12 : 1];
    }
    if (i === 9) return [0, 18, 24, 0, 0, 0, 0.64, 1];
    const side = i === 10 ? -1 : 1;
    return [side * 116, 196, 0, 0, 0, side * 3, 0.48, 1];
  }
  if (scene === 7) {
    // Architecture: four horizontal layers, clients on top, Neo4j at the bottom.
    return [((i % 3) - 1) * 134, 0, (Math.floor(i / 3) - 1.5) * 112, 0, 0, 0, 0.72, 1];
  }
  // Memory: recent messages stay open, older ones fold into one digest stack.
  if (i < 4) return [-150 + ((i % 2) - 0.5) * 106, -14 + (Math.floor(i / 2) - 0.5) * 76, (3 - i) * 10, 0, -8, -4, 0.56, 1];
  return [158 + (i - 4) * 2, 18 + (i - 4) * 4, -(i - 4) * 20, 0, 0, 0, 0.64, mix(1, 0.35, (i - 4) / 7)];
}

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
  const header = document.querySelector(".nav");
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
    const darkness = (scene) => (darkScenes.has(sceneNames[scene]) ? 1 : 0);
    const dark = mix(darkness(index), darkness(next), t);
    const database = mix(sceneNames[index] === "database" ? 1 : 0, sceneNames[next] === "database" ? 1 : 0, t);
    const narrow = window.innerWidth <= 700;
    const stacked = window.innerWidth <= 1050;
    const storyLeft = narrow ? 50 : index === 0 ? mix(72, 68, t) : 68;
    stage.style.setProperty("--rig-left", `${mix(storyLeft, narrow ? 25 : stacked ? 32 : 58, database)}%`);
    stage.style.setProperty("--rig-top", `${mix(narrow ? 69 : 52, narrow ? 70 : stacked ? 68 : 52, database)}%`);
    stage.style.setProperty("--scene-background", blendColor([246, 245, 241], [17, 23, 24], dark));
    stage.style.setProperty("--scene-label", blendColor([45, 73, 60], [210, 231, 219], dark));
    stage.style.setProperty("--atmosphere-opacity", String(1 - dark * 0.8));
    header?.classList.toggle("is-dark", dark > 0.5);
    stage.style.setProperty("--shadow-opacity", String(0.6 - dark * 0.5));
    stage.style.setProperty("--word-opacity", String(index === 0 ? (1 - t) * 0.85 : 0));
    stage.style.setProperty("--mobile-scale", String(index === 0 ? mix(0.57, 0.66, t) : 0.66));
    journey.style.setProperty("--chapter-ink", blendColor([27, 31, 29], [245, 245, 247], dark));
    journey.style.setProperty("--chapter-soft", blendColor([58, 64, 60], [186, 196, 195], dark));

    const sceneView = scene => scene === 7 && narrow ? [57, 0, -24, 0.6] : views[scene];
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
    nav.hidden = y > journey.offsetTop + journey.offsetHeight - window.innerHeight * 0.6;
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
      if (value) measure();
      else {
        header?.classList.remove("is-dark");
        journey.style.removeProperty("--chapter-ink");
        journey.style.removeProperty("--chapter-soft");
      }
    },
  };
}
