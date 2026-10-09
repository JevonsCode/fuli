import { createScrollScene } from "./scroll-scene.js";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const shortViewport = window.matchMedia("(max-height: 560px)");
const motionToggle = document.querySelector("#motion-toggle");
const scene = createScrollScene();
let userReduced = false;

function applyMotion() {
  const reduced = reducedMotion.matches || userReduced;
  scene.setEnabled(!reduced && !shortViewport.matches);
  motionToggle.setAttribute("aria-pressed", String(reduced));
  motionToggle.textContent = reducedMotion.matches
    ? "已跟随系统减少动效"
    : reduced
      ? "体验滚动动效"
      : "减少动效";
  motionToggle.disabled = reducedMotion.matches;
}
motionToggle.hidden = false;
motionToggle.addEventListener("click", () => {
  // Keep the visible content as the reading anchor when switching layouts.
  const anchor = document
    .elementFromPoint(window.innerWidth * 0.2, window.innerHeight * 0.45)
    ?.closest("section");
  userReduced = !userReduced;
  applyMotion();
  anchor?.scrollIntoView({ block: "start" });
});
reducedMotion.addEventListener("change", applyMotion);
shortViewport.addEventListener("change", applyMotion);
applyMotion();

const copyButton = document.querySelector("#copy-install");
const copyStatus = document.querySelector("#copy-status");
const installCommand = document.querySelector("#install-command");
copyButton.hidden = false;
copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  try {
    if (!navigator.clipboard?.writeText)
      throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(installCommand.textContent.trim());
    copyStatus.textContent = "已复制";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(installCommand);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    copyStatus.textContent = "请手动复制已选中的命令";
  } finally {
    copyButton.disabled = false;
  }
});
