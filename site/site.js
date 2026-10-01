import {
  pageProgress,
  resolveReducedMotion,
  sceneProgress,
  stageForProgress,
  stageScrollTarget,
} from "./scroll-state.js";

const body = document.body;
const header = document.querySelector(".site-header");
const progressBar = document.querySelector(".page-progress");
const hero = document.querySelector('[data-scroll-scene="hero"]');
const motionToggle = document.querySelector("#motion-toggle");
const menuToggle = document.querySelector("#menu-toggle");
const systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const desktop = window.matchMedia("(min-width: 701px)");
const shortViewport = window.matchMedia("(max-height: 735px)");
const motionStorageKey = "fuli-site-motion";
let userMotionPreference = null;
let reducedMotion = systemMotion.matches;
let framePending = false;

try {
  const stored = window.localStorage.getItem(motionStorageKey);
  if (stored === "reduced") userMotionPreference = true;
  if (stored === "full") userMotionPreference = false;
} catch {
  // Storage can be disabled; the current page still remembers the choice.
}

const scenes = ["architecture", "workflow"].flatMap((name) => {
  const element = document.querySelector(`[data-scroll-scene="${name}"]`);
  if (!element) return [];
  return [
    {
      name,
      element,
      buttons: [...element.querySelectorAll(`[data-${name}-step]`)],
      counter: element.querySelector(`[data-${name}-count]`),
      stage: -1,
      count: 4,
    },
  ];
});

const navSections = [
  ...document.querySelectorAll("[data-nav-section]"),
].flatMap((link) => {
  const id = link.dataset.navSection || link.hash?.slice(1);
  const section = id ? document.getElementById(id.replace(/^#/, "")) : null;
  return section ? [{ link, section }] : [];
});

function setStage(scene, nextStage) {
  if (scene.stage === nextStage) return;
  scene.stage = nextStage;
  scene.element.dataset.stage = String(nextStage);
  scene.buttons.forEach((button) => {
    const active = Number(button.dataset[`${scene.name}Step`]) === nextStage;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (scene.counter) {
    scene.counter.textContent = `${String(nextStage + 1).padStart(2, "0")} / ${String(scene.count).padStart(2, "0")}`;
  }
}

function renderScroll() {
  framePending = false;
  const viewportHeight = window.innerHeight;
  const scrollTop = window.scrollY;
  if (header) header.dataset.scrolled = String(scrollTop > 24);
  progressBar?.style.setProperty(
    "--page-progress",
    String(
      pageProgress(
        scrollTop,
        document.documentElement.scrollHeight,
        viewportHeight,
      ),
    ),
  );

  if (!reducedMotion && !shortViewport.matches) {
    if (hero) {
      const bounds = hero.getBoundingClientRect();
      hero.style.setProperty(
        "--hero-progress",
        String(sceneProgress(bounds.top, bounds.height, viewportHeight)),
      );
    }
    scenes.forEach((scene) => {
      const bounds = scene.element.getBoundingClientRect();
      const progress = sceneProgress(bounds.top, bounds.height, viewportHeight);
      scene.element.style.setProperty("--scene-progress", String(progress));
      setStage(scene, stageForProgress(progress, scene.count));
    });
  }

  // Keep the previous section selected until the next reaches the reading line.
  const readingLine = Math.min(viewportHeight * 0.35, 240);
  let currentSection = null;
  navSections.forEach(({ section }) => {
    if (section.getBoundingClientRect().top <= readingLine)
      currentSection = section;
  });
  navSections.forEach(({ link, section }) => {
    if (section === currentSection)
      link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

function scheduleScroll() {
  if (framePending) return;
  framePending = true;
  window.requestAnimationFrame(renderScroll);
}

function applyMotionPreference() {
  reducedMotion = resolveReducedMotion(
    systemMotion.matches,
    userMotionPreference,
  );
  body.classList.toggle("motion-reduced", reducedMotion);
  if (motionToggle) {
    motionToggle.setAttribute("aria-pressed", String(reducedMotion));
    motionToggle.disabled = systemMotion.matches;
    motionToggle.textContent = systemMotion.matches
      ? "已减少动效"
      : reducedMotion
        ? "启用动效"
        : "减少动效";
  }
  if (reducedMotion || shortViewport.matches) {
    hero?.style.setProperty("--hero-progress", "0");
    scenes.forEach((scene) =>
      scene.element.style.setProperty("--scene-progress", "0"),
    );
  }
  if (reducedMotion) {
    document
      .querySelectorAll("[data-reveal]")
      .forEach((element) => element.classList.add("is-visible"));
  }
  scheduleScroll();
}

scenes.forEach((scene) => {
  setStage(scene, 0);
  scene.buttons.forEach((button) => {
    button.disabled = false;
    button.addEventListener("click", () => {
      const nextStage = Number(button.dataset[`${scene.name}Step`]);
      if (
        !Number.isInteger(nextStage) ||
        nextStage < 0 ||
        nextStage >= scene.count
      )
        return;
      if (reducedMotion || shortViewport.matches) {
        setStage(scene, nextStage);
        return;
      }
      const bounds = scene.element.getBoundingClientRect();
      window.scrollTo({
        top: stageScrollTarget(
          bounds.top + window.scrollY,
          bounds.height,
          window.innerHeight,
          nextStage,
          scene.count,
        ),
        behavior: "smooth",
      });
    });
  });
});

if (motionToggle) {
  motionToggle.hidden = false;
  motionToggle.addEventListener("click", () => {
    userMotionPreference = !reducedMotion;
    try {
      window.localStorage.setItem(
        motionStorageKey,
        userMotionPreference ? "reduced" : "full",
      );
    } catch {
      // Respect the choice even when persistence is unavailable.
    }
    applyMotionPreference();
  });
}

function setMenuOpen(open, restoreFocus = false) {
  if (!header || !menuToggle) return;
  header.dataset.menuOpen = String(open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  if (restoreFocus) menuToggle.focus();
}

if (menuToggle) {
  menuToggle.hidden = false;
  setMenuOpen(false);
  menuToggle.addEventListener("click", () =>
    setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true"),
  );
  header?.querySelectorAll('nav a[href^="#"]').forEach((link) => {
    link.addEventListener("click", () => setMenuOpen(false));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header?.dataset.menuOpen === "true")
      setMenuOpen(false, true);
  });
  document.addEventListener("click", (event) => {
    if (header?.dataset.menuOpen === "true" && !header.contains(event.target))
      setMenuOpen(false);
  });
  desktop.addEventListener("change", () => {
    if (desktop.matches) setMenuOpen(false);
  });
}

const reveals = [...document.querySelectorAll("[data-reveal]")];
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -24px 0px" },
  );
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add("is-visible"));
}

const copyButton = document.querySelector("#copy-install");
const installCommand = document.querySelector("#install-command");
const copyStatus = document.querySelector("#copy-status");
if (copyButton && installCommand) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    copyButton.disabled = true;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(installCommand.textContent.trim());
      if (copyStatus) copyStatus.textContent = "已复制，粘贴到终端即可。";
      copyButton.textContent = "已复制";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(installCommand);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (copyStatus)
        copyStatus.textContent = "无法自动复制，命令已选中，请手动复制。";
    } finally {
      copyButton.disabled = false;
    }
  });
}

systemMotion.addEventListener("change", applyMotionPreference);
shortViewport.addEventListener("change", applyMotionPreference);
window.addEventListener("scroll", scheduleScroll, { passive: true });
window.addEventListener("resize", scheduleScroll, { passive: true });
window.addEventListener("pageshow", scheduleScroll);
document.fonts?.ready.then(scheduleScroll);
applyMotionPreference();
body.classList.add("js");
