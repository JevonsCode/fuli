const scenes = [
  {
    nodes: [
      ["Codex", "开始设计"],
      ["Claude Code", "接着开发"],
      ["Cursor", "继续验证"],
      ["下一次会话", "带着上下文回来"],
    ],
    caption: "同一个名字，同一段工作脉络。",
  },
  {
    nodes: [
      ["HR", "寻找合适的专长"],
      ["小组长", "协调分工与借调"],
      ["Noa · 验证", "独立检查结果"],
      ["Jefa", "跟进进展与交付"],
    ],
    caption: "分工明确，协作有据可查。",
  },
  {
    nodes: [
      ["近期上下文", "默认 7 天不活跃窗口"],
      ["归档摘要", "更早的工作脉络"],
      ["相关证据", "需要时再取回"],
      ["上下文预算", "避免整段历史注入"],
    ],
    caption: "记忆在增长，输入仍然有边界。",
  },
  {
    nodes: [
      ["品味", "希望得到怎样的结果"],
      ["个性", "习惯怎样协作"],
      ["判断偏好", "如何取舍与决定"],
      ["人的确认", "来源、范围与修订"],
    ],
    caption: "更懂得你，也尊重你的判断。",
  },
];

const diagram = document.querySelector(".diagram");
const steps = [...document.querySelectorAll(".story-step")];
const stage = document.querySelector(".story-stage");
const counter = document.querySelector(".stage-count");
const dots = [...document.querySelectorAll(".scene-dots i")];
const motionToggle = document.querySelector("#motion-toggle");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const narrowScreen = window.matchMedia("(max-width: 700px)");
const compound = document.querySelector(".compounding");
let userPaused = false;
let activeScene = -1;
let scheduled = false;

function setScene(index) {
  if (index === activeScene) return;
  activeScene = index;
  diagram.dataset.scene = String(index);
  scenes[index].nodes.forEach(([name, detail], i) => {
    const key = ["a", "b", "c", "d"][i];
    diagram.querySelector(`[data-node="${key}"]`).textContent = name;
    diagram.querySelector(`[data-detail="${key}"]`).textContent = detail;
  });
  diagram.querySelector(".diagram-caption").textContent = scenes[index].caption;
  counter.textContent = `${index + 1} / ${scenes.length}`;
  dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
}

function renderScroll() {
  scheduled = false;
  // The diagram follows the text crossing the reading line. On compact screens
  // that line sits immediately below the sticky illustration.
  const readingLine = narrowScreen.matches
    ? stage.getBoundingClientRect().height + 100
    : window.innerHeight * 0.55;
  let index = 0;
  steps.forEach((step, i) => {
    if (step.getBoundingClientRect().top <= readingLine) index = i;
  });
  setScene(index);
  if (!userPaused && !reducedMotion.matches) {
    const rect = compound.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < window.innerHeight) {
      compound.style.setProperty(
        "--wheel",
        `${(window.innerHeight - rect.top) * 0.025}deg`,
      );
    }
  }
}

function scheduleScroll() {
  if (!scheduled) {
    scheduled = true;
    window.requestAnimationFrame(renderScroll);
  }
}

function applyMotionPreference() {
  const paused = userPaused || reducedMotion.matches;
  document.body.classList.toggle("motion-paused", paused);
  motionToggle.setAttribute("aria-pressed", String(paused));
  motionToggle.textContent = reducedMotion.matches
    ? "已减少动效"
    : paused
      ? "启用动效"
      : "暂停动效";
  motionToggle.disabled = reducedMotion.matches;
  const orbit = document.querySelector(".hero-orbit svg");
  if (paused) orbit.pauseAnimations?.();
  else orbit.unpauseAnimations?.();
  scheduleScroll();
}

motionToggle.hidden = false;
motionToggle.addEventListener("click", () => {
  userPaused = !userPaused;
  applyMotionPreference();
});
reducedMotion.addEventListener("change", applyMotionPreference);
window.addEventListener("scroll", scheduleScroll, { passive: true });
window.addEventListener("resize", scheduleScroll, { passive: true });
applyMotionPreference();

const copyButton = document.querySelector("#copy-install");
const copyStatus = document.querySelector("#copy-status");
copyButton.hidden = false;
copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  const command = document.querySelector(".install code").textContent.trim();
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(command);
    copyStatus.textContent = "已复制，粘贴到终端即可。";
    copyButton.textContent = "已复制";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".install code"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    copyStatus.textContent = "无法自动复制，命令已选中，请手动复制。";
  } finally {
    copyButton.disabled = false;
  }
});
