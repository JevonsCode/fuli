const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const fragments = [
  ["身份", "持续的名字", "jade"],
  ["项目", "职责与边界", "silver"],
  ["对话", "可见的记录", "silver"],
  ["品味", "经过确认的偏好", "jade"],
  ["上下文", "当下相关的脉络", "silver"],
  ["协作", "伙伴与分工", "carbon"],
  ["来源", "保留证据", "silver"],
  ["判断", "取舍的依据", "silver"],
  ["记忆", "工作持续积累", "jade"],
  ["历史", "变化可以追溯", "silver"],
  ["权限", "明确的作用域", "carbon"],
  ["期待", "由你来定义", "silver"],
];
const paths = [
  "M16 8a4 4 0 1 1-8 0a4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  "M3 7h7l2 3h9v10H3z",
  "M4 4h16v12H9l-5 4zM8 8h8M8 12h5",
  "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z",
];
function createFragment([title, detail, material], index) {
  const item = document.createElement("div");
  item.className = `fragment fragment-${material}`;
  const face = document.createElement("div");
  face.className = "fragment-face fragment-front";
  // All artwork and labels are static public mechanism illustrations.
  face.innerHTML = `<div class="fragment-heading"><span>${title}</span><svg viewBox="0 0 24 24"><path d="${paths[index % paths.length]}"/></svg></div><div class="fragment-lines"><i></i><i></i><i></i></div><span class="fragment-detail">${detail}</span>`;
  item.append(face);
  for (const side of ["back", "top", "bottom", "left", "right"]) {
    const surface = document.createElement("div");
    surface.className = `fragment-face fragment-${side}`;
    item.append(surface);
  }
  return item;
}
// Every pose carries the same twelve pieces through a different explanation.
// Positions are in the object's own coordinate space, independently of viewport.
function pose(scene, i) {
  const column = i % 2,
    row = Math.floor(i / 2) % 2,
    layer = Math.floor(i / 4);
  if (scene === 0) {
    const scatter = [
      [-185, -112, 135, -12, 8, -9],
      [73, -125, 60, 8, -13, 7],
      [-212, 38, 18, 8, -12, -9],
      [89, 28, 118, -7, 8, 6],
      [-96, -2, -68, -8, 11, -5],
      [205, -24, -42, 11, 8, 12],
      [-220, 185, -42, 5, 17, 4],
      [105, 197, 8, -6, -7, -7],
      [-18, 151, 160, -12, 5, 5],
      [215, 143, -105, 12, 6, 7],
      [-54, -181, -100, 7, -15, -8],
      [220, -173, 94, -5, 10, 10],
    ][i];
    return [...scatter, 0.88, 1];
  }
  if (scene === 1)
    return [
      (column - 0.5) * 184,
      (row - 0.5) * 120,
      (layer - 1) * 25,
      0,
      0,
      0,
      1,
      1,
    ];
  if (scene === 2)
    return [
      ((i % 3) - 1) * 134,
      0,
      (Math.floor(i / 3) - 1.5) * 112,
      0,
      0,
      0,
      0.72,
      1,
    ];
  if (scene === 3) {
    const group = Math.floor(i / 4),
      j = i % 4;
    const center = [
      [-176, -100],
      [170, -100],
      [0, 145],
    ][group];
    return [
      center[0] + ((j % 2) - 0.5) * 83,
      center[1] + (Math.floor(j / 2) - 0.5) * 55,
      (j % 2) * 8,
      0,
      0,
      (group - 1) * 5,
      0.43,
      1,
    ];
  }
  if (scene === 4) {
    if (i < 4)
      return [
        -150 + ((i % 2) - 0.5) * 106,
        -14 + (Math.floor(i / 2) - 0.5) * 76,
        (3 - i) * 10,
        0,
        -8,
        -4,
        0.56,
        1,
      ];
    return [
      158 + (i - 4) * 2,
      18 + (i - 4) * 4,
      -(i - 4) * 20,
      0,
      0,
      0,
      0.64,
      mix(1, 0.35, (i - 4) / 7),
    ];
  }
  if (scene === 5) {
    const group = Math.floor(i / 4),
      j = i % 4;
    const center = [
      [-183, -77],
      [177, -77],
      [0, 152],
    ][group];
    return [
      center[0] + j * 8,
      center[1] + j * 9,
      -j * 20,
      0,
      0,
      [-15, 15, 0][group],
      0.58,
      1 - j * 0.08,
    ];
  }
  const group = Math.floor(i / 3),
    j = i % 3;
  const center = [
    [-167, -90],
    [167, -90],
    [-167, 134],
    [167, 134],
  ][group];
  return [
    center[0] + j * 9,
    center[1] + j * 7,
    -j * 16,
    0,
    0,
    group % 2 ? 8 : -8,
    0.54,
    1 - j * 0.05,
  ];
}
const views = [
  [48, -10, -25, 1],
  [52, -8, -28, 1.12],
  [57, 0, -24, 0.85],
  [18, -7, 0, 1.04],
  [35, -12, -9, 1.04],
  [24, -6, 0, 1.03],
  [22, -6, 0, 1.06],
];
const sceneNames = [
  "scatter",
  "identity",
  "architecture",
  "continuity",
  "memory",
  "taste",
  "team",
];
function blendColor(a, b, t) {
  return `rgb(${a.map((v, i) => Math.round(mix(v, b[i], t))).join(" ")})`;
}
export function createScrollScene() {
  const journey = document.querySelector(".journey");
  const rig = document.querySelector("#fragment-rig");
  const stage = document.querySelector(".spatial-stage");
  const chapters = [...document.querySelectorAll(".chapter")];
  const nav = document.querySelector(".chapter-nav");
  const dots = [...nav.querySelectorAll("a")];
  const overlays = [...document.querySelectorAll("[data-overlay]")];
  const pieces = fragments.map(createFragment);
  pieces.forEach((piece) => rig.append(piece));
  const architecturePaths = [
    ...document.querySelectorAll(".architecture-paths > path"),
  ];
  const layerNotes = [...document.querySelectorAll(".layer-note")];
  const handoffPaths = [...document.querySelectorAll(".handoff-route")];
  const identityLabel = document.querySelector(".identity-label");
  // Read projected anchors together after transforms, then write SVG paths.
  // This only runs during scroll/resize frames; there is no idle animation loop.
  function connectMechanism(scene) {
    const bounds = stage.getBoundingClientRect();
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left - bounds.left,
        right: r.right - bounds.left,
        top: r.top - bounds.top,
        bottom: r.bottom - bounds.top,
        x: (r.left + r.right) / 2 - bounds.left,
        y: (r.top + r.bottom) / 2 - bounds.top,
      };
    };
    if (scene === 2) {
      const points = [11, 8, 5, 2].map((i, j) => ({
        a: rect(pieces[i]),
        b: rect(layerNotes[j]),
      }));
      points.forEach(({ a, b }, i) => {
        const end = b.left - 8,
          elbow = end - 14;
        architecturePaths[i].setAttribute(
          "d",
          `M${a.right + 3} ${a.y} H${elbow} V${b.y} H${end}`,
        );
      });
      const x = points[0].b.left - 22,
        start = points[0].b.y,
        end = points[3].b.y;
      architecturePaths[4].setAttribute(
        "d",
        `M${x} ${start} V${end} m-3 -5 3 5 3 -5`,
      );
    }
    if (scene === 3) {
      const a = rect(pieces[1]),
        b = rect(pieces[4]),
        c = rect(pieces[8]),
        center = rect(identityLabel);
      const routes = [
        `M${a.right + 7} ${a.y} C${center.left - 22} ${a.y} ${center.left - 22} ${center.y} ${center.left - 8} ${center.y}`,
        `M${center.right + 8} ${center.y} C${b.left - 22} ${center.y} ${b.left - 22} ${b.y} ${b.left - 7} ${b.y}`,
        `M${center.x} ${center.bottom + 12} V${c.top - 17} H${c.x} V${c.top - 7}`,
      ];
      routes.forEach((d, i) => handoffPaths[i].setAttribute("d", d));
    }
  }
  let enabled = false,
    scheduled = false,
    positions = [],
    heights = [],
    active = -1;
  function measure() {
    positions = chapters.map(
      (chapter) => chapter.getBoundingClientRect().top + window.scrollY,
    );
    heights = chapters.map((chapter) => chapter.offsetHeight);
    schedule();
  }
  function render() {
    scheduled = false;
    if (!enabled) return;
    const y = window.scrollY;
    // The reading dwell occupies the first 45% of each chapter; the next 45%
    // performs one continuous transformation into the following explanation.
    let index = 0;
    while (index < positions.length - 1 && y >= positions[index + 1]) index++;
    const length =
      (positions[index + 1] ?? positions[index] + heights[index]) -
      positions[index];
    const local = clamp((y - positions[index]) / length);
    const next = Math.min(index + 1, sceneNames.length - 1);
    const t = smooth(clamp((local - 0.43) / 0.48));
    const darkA = index === 2 ? 1 : 0,
      darkB = next === 2 ? 1 : 0;
    const dark = mix(darkA, darkB, t);
    stage.style.setProperty(
      "--scene-background",
      blendColor([245, 245, 247], [17, 23, 24], dark),
    );
    stage.style.setProperty(
      "--scene-label",
      blendColor([45, 73, 60], [210, 231, 219], dark),
    );
    stage.style.setProperty("--atmosphere-opacity", String(1 - dark * 0.8));
    stage.style.setProperty("--rig-left", `${mix(68, 61, dark)}%`);
    stage.style.setProperty("--rig-mobile-left", `${mix(50, 36, dark)}%`);
    stage.style.setProperty(
      "--mobile-scale",
      String(index === 0 ? mix(0.57, 0.68, t) : 0.68),
    );
    stage.style.setProperty(
      "--word-opacity",
      String(index === 0 ? (1 - t) * 0.85 : 0),
    );
    stage.style.setProperty("--shadow-opacity", String(0.6 - dark * 0.5));
    const view = views[index].map((v, j) => mix(v, views[next][j], t));
    rig.style.transform = `rotateX(${view[0]}deg) rotateY(${view[1]}deg) rotateZ(${view[2]}deg) scale(${view[3]})`;
    pieces.forEach((piece, i) => {
      const a = pose(index, i),
        b = pose(next, i),
        v = a.map((value, j) => mix(value, b[j], t));
      piece.style.transform = `translate3d(${v[0]}px,${v[1]}px,${v[2]}px) rotateX(${v[3]}deg) rotateY(${v[4]}deg) rotateZ(${v[5]}deg) scale(${v[6]})`;
      piece.style.opacity = String(v[7]);
    });
    chapters.forEach((chapter, i) => {
      const start = positions[i],
        distance = y - start;
      const fadeIn =
        i === 0
          ? 1
          : clamp(
              (distance + window.innerHeight * 0.28) /
                (window.innerHeight * 0.25),
            );
      const fadeOut =
        1 - clamp((y - start - heights[i] * 0.56) / (heights[i] * 0.28));
      const opacity = Math.min(fadeIn, fadeOut);
      chapter.style.setProperty("--copy-opacity", String(opacity));
      chapter.style.setProperty("--copy-y", `${mix(22, 0, smooth(fadeIn))}px`);
    });
    overlays.forEach((overlay) => {
      const scene = sceneNames.indexOf(overlay.dataset.overlay);
      const opacity = scene === index ? 1 - t : scene === next ? t : 0;
      overlay.classList.toggle("is-active", opacity > 0.01);
      overlay.style.opacity = String(opacity);
    });
    const current = t > 0.5 ? next : index;
    if (index === 2 || next === 2) connectMechanism(2);
    if (index === 3 || next === 3) connectMechanism(3);
    if (current !== active) {
      active = current;
      const architectureLabels = [
        "关系",
        "历史",
        "工作记忆",
        "身份与权限",
        "来源与确认",
        "上下文",
        "CLI",
        "MCP",
        "HTTP",
        "Codex",
        "Claude Code",
        "Cursor",
      ];
      pieces.forEach((piece, i) => {
        piece.querySelector(".fragment-heading>span").textContent =
          current === 2 ? architectureLabels[i] : fragments[i][0];
        piece.querySelector(".fragment-detail").textContent =
          current === 2 ? "Fuli architecture" : fragments[i][1];
      });
      stage.dataset.scene = sceneNames[current];
      dots.forEach((dot, i) => {
        if (i === current) dot.setAttribute("aria-current", "step");
        else dot.removeAttribute("aria-current");
      });
    }
    nav.hidden =
      y > journey.offsetTop + journey.offsetHeight - window.innerHeight * 0.6;
  }
  function schedule() {
    if (enabled && !scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }
  const resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(journey);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", measure, { passive: true });
  document.fonts.ready.then(measure);
  function setEnabled(value) {
    enabled = value;
    document.body.classList.toggle("enhanced", value);
    nav.hidden = !value;
    if (value) measure();
  }
  return { setEnabled };
}
