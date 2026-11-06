// Regenerates the website's client screenshots (site/assets/screens/) from a throwaway FULI that
// holds synthetic demo data only. Run it each release, against an instance set up just for this:
//
//   fuli setup --data-dir <a new temp dir> --port 3979 --personal-only --skip-agents --yes
//   node scripts/site-screenshots.js --console http://127.0.0.1:3979 --seed
//
// --seed writes the synthetic projects, FLAs, tasks, knowledge and requests (scripts/site-demo-data.js)
// through the console's own API; without it the script only captures. It refuses any host other
// than 127.0.0.1/localhost and the usual FULI ports 2727 and 2828, so it never touches a real install. Screens are taken at 1280x800 in the light theme with
// a 2x device scale, in Chinese and English, and written as WebP at 1600 and 800 pixels wide,
// encoded by the browser itself (no image library).
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { isMainModule } from '../src/system/main-module.js';
import { seedDemo } from './site-demo-data.js';

const OUT = new URL('../site/assets/screens/', import.meta.url);
const VIEWPORT = { width: 1280, height: 800 };
const WIDTHS = [1600, 800];
const LOCALES = [['zh', 'zh-CN'], ['en', 'en-US']];
const REAL_PORTS = new Set(['2727', '2828']);

export function throwawayConsole(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('The screenshot console must be on this computer');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (REAL_PORTS.has(port)) throw new Error(`Port ${port} is a real FULI install; use a throwaway instance`);
  return url.origin;
}

// Waits until the page shows content: no loading indicator left, and the network quiet.
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .growth-loading'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function encodeWebp(browser, png) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ data, widths }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + data;
      await image.decode();
      return widths.map((width) => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(image.height * width / image.width);
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', 0.86).split(',')[1];
      });
    }, { data: png.toString('base64'), widths: WIDTHS });
  } finally {
    await page.close();
  }
}

export async function captureScreens(origin, screens, { channel = 'msedge' } = {}) {
  const browser = await chromium.launch({ channel });
  try {
    await mkdir(OUT, { recursive: true });
    for (const [suffix, locale] of LOCALES) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, locale, colorScheme: 'light' });
      const page = await context.newPage();
      for (const { name, path, firstRun, prepare } of screens) {
        // The first open: the demo has already answered "getting started", so for this one screen
        // the console is told what a new install says (guide open, not answered, recording off).
        if (firstRun) {
          const notAnswered = { ask: true, capturePolicy: { enabled: false, disabledSources: [], projectMode: 'all', excludedProjectIds: [], selectedProjectIds: [], unregisteredDirectories: 'capture', projectsOffSince: {}, unlistedProjectsOffSince: null } };
          await page.route('**/api/capture-onboarding', (route) => route.fulfill({ json: notAnswered }));
          await page.route('**/api/state', async (route) => {
            const response = await route.fetch();
            route.fulfill({ response, json: { ...(await response.json()), captureOnboarding: notAnswered, firstRunGuide: { open: true } } });
          });
        }
        await page.goto(origin + path);
        await settle(page);
        await prepare?.(page);
        if (firstRun) await page.unrouteAll({ behavior: 'ignoreErrors' });
        const encoded = await encodeWebp(browser, await page.screenshot({ type: 'png' }));
        for (const [i, width] of WIDTHS.entries()) {
          await writeFile(new URL(`${name}-${suffix}-${width}.webp`, OUT), Buffer.from(encoded[i], 'base64'));
        }
        console.log(`captured ${name} (${suffix})`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
}

if (isMainModule(import.meta.url)) {
  const origin = throwawayConsole(option('--console', 'http://127.0.0.1:3979'));
  const demo = await seedDemo(origin, { write: process.argv.includes('--seed') });
  const only = option('--only', '')?.split(',').filter(Boolean) ?? [];
  const screens = only.length ? demo.screens.filter((screen) => only.includes(screen.name)) : demo.screens;
  await captureScreens(origin, screens, { channel: option('--browser', 'msedge') });
}
