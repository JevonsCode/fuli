import assert from "node:assert/strict";
import test from "node:test";
import {
  clampProgress,
  pageProgress,
  resolveReducedMotion,
  sceneProgress,
  stageForProgress,
  stageScrollTarget,
} from "../site/scroll-state.js";

test("scroll progress stays bounded before, during, and after a sticky scene", () => {
  assert.equal(sceneProgress(250, 3200, 1000), 0);
  assert.equal(sceneProgress(0, 3200, 1000), 0);
  assert.equal(sceneProgress(-1100, 3200, 1000), 0.5);
  assert.equal(sceneProgress(-2200, 3200, 1000), 1);
  assert.equal(sceneProgress(-2600, 3200, 1000), 1);
  assert.equal(clampProgress(Number.NaN), 0);
});

test("short or static scenes have finite progress without a scroll interval", () => {
  assert.equal(sceneProgress(0, 1000, 1000), 0);
  assert.equal(sceneProgress(-1, 1000, 1000), 1);
  assert.equal(sceneProgress(20, 600, 1000), 0);
  assert.equal(sceneProgress(-20, 600, 1000), 1);
});

test("stage changes have predictable boundaries, including the final scroll pixel", () => {
  assert.equal(stageForProgress(-0.2), 0);
  assert.equal(stageForProgress(0), 0);
  assert.equal(stageForProgress(0.24999), 0);
  assert.equal(stageForProgress(0.25), 1);
  assert.equal(stageForProgress(0.5), 2);
  assert.equal(stageForProgress(0.75), 3);
  assert.equal(stageForProgress(1), 3);
  assert.equal(stageForProgress(2), 3);
  assert.equal(stageForProgress(0.5, 1), 0);
});

test("scene buttons land inside the selected stage across responsive sizes", () => {
  for (const viewportHeight of [568, 900, 1200]) {
    const sectionTop = 1800;
    const sectionHeight = viewportHeight * 3.6;
    for (let stage = 0; stage < 4; stage += 1) {
      const target = stageScrollTarget(
        sectionTop,
        sectionHeight,
        viewportHeight,
        stage,
      );
      const progress = sceneProgress(
        sectionTop - target,
        sectionHeight,
        viewportHeight,
      );
      assert.equal(stageForProgress(progress), stage);
      // Rounding the browser scroll position cannot select an adjacent stage.
      assert.equal(
        stageForProgress(
          sceneProgress(
            sectionTop - Math.round(target),
            sectionHeight,
            viewportHeight,
          ),
        ),
        stage,
      );
    }
  }
});

test("scene navigation bounds invalid stages and handles a static scene", () => {
  assert.equal(
    stageScrollTarget(500, 3200, 1000, -5),
    stageScrollTarget(500, 3200, 1000, 0),
  );
  assert.equal(
    stageScrollTarget(500, 3200, 1000, 10),
    stageScrollTarget(500, 3200, 1000, 3),
  );
  assert.equal(stageScrollTarget(500, 800, 1000, 2), 500);
  assert.equal(stageScrollTarget(-500, 800, 1000, 2), 0);
});

test("page progress handles short documents and overscroll", () => {
  assert.equal(pageProgress(0, 800, 1000), 0);
  assert.equal(pageProgress(0, 1000, 1000), 0);
  assert.equal(pageProgress(-20, 4000, 1000), 0);
  assert.equal(pageProgress(1500, 4000, 1000), 0.5);
  assert.equal(pageProgress(3300, 4000, 1000), 1);
});

test("the system's reduced-motion preference always takes priority", () => {
  assert.equal(resolveReducedMotion(true, null), true);
  assert.equal(resolveReducedMotion(false, null), false);
  assert.equal(resolveReducedMotion(false, true), true);
  assert.equal(resolveReducedMotion(false, false), false);
  assert.equal(resolveReducedMotion(true, false), true);
  assert.equal(resolveReducedMotion(true, true), true);
});
