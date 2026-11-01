// Draws the desktop client's icons: the tray's mark on a light rounded square
// with a status dot, and macOS app icons inside the transparent margin macOS
// expects. Wherever the mark sits on a backdrop it is a rounded square, like
// the app icon, never a disc (Jevons 11-01).
import { blankImage, blendPixel, composite, cropToContent, resizeArea } from './raster.js';
import { renderMark } from './svg-raster.js';

const BACKDROP = 0xffffff;
const DOT_RING = 0xffffff;
const MARK_SHARE = 0.74;
const SAMPLES = 4;
// The backdrop's corner radius as a share of its side, matching the app icon's.
export const CORNER_SHARE = 0.225;

// [markFor(pixels)]: the mark cut to draw at that size (the micro cut below 28 px).
export function trayIcon(markFor, size, dot) {
  const canvas = blankImage(size);
  const center = size / 2;
  paintRoundedSquare(canvas, size, size * CORNER_SHARE, BACKDROP);
  const inner = Math.round(size * MARK_SHARE);
  const offset = Math.round((size - inner) / 2);
  composite(canvas, renderMark(markFor(inner), inner), offset, offset);
  // Large enough to read at 16 px, where the mark is mostly a shape.
  const radius = size * 0.25;
  const at = size - radius - size * 0.02;
  paintDisc(canvas, at, at, radius, DOT_RING);
  paintDisc(canvas, at, at, radius - Math.max(1, size * 0.06), dot);
  return canvas;
}

// A ready app icon (its rounded square edge to edge after cropping) scaled into
// [size] with a [margin] share of transparent border on every side.
export function marginedIcon(icon, size, margin) {
  const canvas = blankImage(size);
  const side = Math.round(size * (1 - 2 * margin));
  const offset = Math.round((size - side) / 2);
  composite(canvas, resizeArea(cropToContent(icon), side), offset, offset);
  return canvas;
}

// A [size] square with [corner]-radius corners filling the canvas, antialiased.
function paintRoundedSquare(canvas, size, corner, rgb) {
  const colour = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  const inside = (px, py) => {
    const dx = Math.max(corner - px, 0, px - (size - corner));
    const dy = Math.max(corner - py, 0, py - (size - corner));
    return dx * dx + dy * dy <= corner * corner;
  };
  for (let y = 0; y < Math.min(canvas.height, size); y++) {
    for (let x = 0; x < Math.min(canvas.width, size); x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) covered++;
      }
      blendPixel(canvas, (y * canvas.width + x) * 4, colour, covered / (SAMPLES * SAMPLES));
    }
  }
}

function paintDisc(canvas, cx, cy, radius, rgb) {
  const colour = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  const yEnd = Math.min(canvas.height, Math.ceil(cy + radius));
  const xEnd = Math.min(canvas.width, Math.ceil(cx + radius));
  for (let y = Math.max(0, Math.floor(cy - radius)); y < yEnd; y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x < xEnd; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) / SAMPLES - cx;
          const dy = y + (sy + 0.5) / SAMPLES - cy;
          if (dx * dx + dy * dy <= radius * radius) covered++;
        }
      }
      blendPixel(canvas, (y * canvas.width + x) * 4, colour, covered / (SAMPLES * SAMPLES));
    }
  }
}
