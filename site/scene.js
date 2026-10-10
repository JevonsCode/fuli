// Scroll-driven 3D story: twelve fragments scatter, assemble into one Agent,
// then regroup to explain each idea. Positions are in the rig's own space.
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

const fragments = [
  ["身份", "持续的名字", "jade"],
  ["职责", "负责的项目", "silver"],
  ["对话", "最近的原文", "silver"],
  ["品味", "确认过的偏好", "jade"],
  ["上下文", "当下相关的脉络", "silver"],
  ["协作", "谁负责谁协助", "carbon"],
  ["来源", "保留证据", "silver"],
  ["判断", "取舍的依据", "silver"],
  ["记忆", "按量折叠的摘要", "jade"],
  ["历史", "变化可以追溯", "silver"],
  ["权限", "明确的作用域", "carbon"],
  ["期待", "由你来定义", "silver"],
];
// Some scenes relabel the same pieces so the object explains that idea.
const sceneLabels = {
  roundtable: [
    ["Milo", "Claude Code"], ["Nova", "Codex"], ["Jefa", "项目经理"], ["Bole", "HR"],
    ["Lyra", "Codex"], ["Ada", "Cursor"], ["提问", "Milo → Nova"], ["回答", "Nova → Milo"],
    ["留痕", "谁问了谁"], ["唤醒", "原会话"], ["收件箱", "下次接手时"], ["线程", "全程可查"],
  ],
  team: [
    ["Jefa", "项目经理"], ["看板", "拆解与进展"], ["目标", "交付节奏"], ["找人", "为任务匹配"],
    ["Bole", "HR"], ["招募", "留下原因"], ["分布", "谁在忙什么"], ["记录", "可审计"],
    ["Milo", "负责人"], ["Nova", "评审"], ["Ada", "测试"], ["记忆", "各自保留"],
  ],
};
const icons = [
  "M16 8a4 4 0 1 1-8 0a4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  "M3 7h7l2 3h9v10H3z",
  "M4 4h16v12H9l-5 4zM8 8h8M8 12h5",
  "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z",
];
const sceneNames = ["scatter", "owner", "handoff", "roundtable", "taste", "team", "memory"];
// Rig orientation per scene: rotateX, rotateY, rotateZ, scale.
const views = [
  [48, -10, -25, 1],
  [52, -8, -26, 1.12],
  [30, -8, -6, 1.02],
  [62, 0, 0, 0.92],
  [56, -14, -30, 1],
  [24, -6, 0, 1.04],
  [36, -12, -10, 1.04],
];

function createFragment([title, detail, material], index) {
  const item = document.createElement("div");
  item.className = `fragment fragment-${material}`;
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
    // Team: PM, HR and the project group, each piece of a group stacked.
    const group = Math.floor(i / 4), j = i % 4;
    const center = [[-185, -85], [185, -85], [0, 150]][group];
    return [center[0] + j * 8, center[1] + j * 9, -j * 20, 0, 0, [-12, 12, 0][group], 0.58, 1 - j * 0.08];
  }
  // Memory: recent messages stay open, older ones fold into one digest stack.
  if (i < 4) return [-150 + ((i % 2) - 0.5) * 106, -14 + (Math.floor(i / 2) - 0.5) * 76, (3 - i) * 10, 0, -8, -4, 0.56, 1];
  return [158 + (i - 4) * 2, 18 + (i - 4) * 4, -(i - 4) * 20, 0, 0, 0, 0.64, mix(1, 0.35, (i - 4) / 7)];
}

function blendColor(a, b, t) {
  return `rgb(${a.map((value, i) => Math.round(mix(value, b[i], t))).join(" ")})`;
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
    const darkness = (scene) => (sceneNames[scene] === "roundtable" ? 1 : 0);
    const dark = mix(darkness(index), darkness(next), t);
    stage.style.setProperty("--scene-background", blendColor([246, 245, 241], [17, 23, 24], dark));
    stage.style.setProperty("--scene-label", blendColor([45, 73, 60], [210, 231, 219], dark));
    stage.style.setProperty("--atmosphere-opacity", String(1 - dark * 0.8));
    stage.style.setProperty("--shadow-opacity", String(0.6 - dark * 0.5));
    stage.style.setProperty("--word-opacity", String(index === 0 ? (1 - t) * 0.85 : 0));
    stage.style.setProperty("--mobile-scale", String(index === 0 ? mix(0.57, 0.66, t) : 0.66));
    journey.style.setProperty("--chapter-ink", blendColor([27, 31, 29], [245, 245, 247], dark));
    journey.style.setProperty("--chapter-soft", blendColor([58, 64, 60], [186, 196, 195], dark));

    const view = views[index].map((value, j) => mix(value, views[next][j], t));
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
    });

    const current = t > 0.5 ? next : index;
    if (current !== active) {
      active = current;
      const labels = sceneLabels[sceneNames[current]];
      pieces.forEach((piece, i) => {
        const [title, detail] = labels?.[i] ?? fragments[i];
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
    setEnabled(value) {
      enabled = value;
      document.body.classList.toggle("enhanced", value);
      nav.hidden = !value;
      if (value) measure();
      else {
        journey.style.removeProperty("--chapter-ink");
        journey.style.removeProperty("--chapter-soft");
      }
    },
  };
}
