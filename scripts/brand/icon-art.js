// Draws the desktop client's icons from the logo. The arithmetic follows the
// Dart `image` 4.x package (average resize, alpha compositing, truncation to
// bytes) that produced the first icons, so regenerating keeps their pixels.
const BACKDROP = 0xffffff;
const DOT_RING = 0xffffff;
const LOGO_SHARE = 0.74;
const CORNER_SHARE = 0.225;
const SAMPLES = 4;

function blankImage(size) {
  return { width: size, height: size, data: new Uint8Array(size * size * 4) };
}

// The app icon: the logo on a light rounded square. [margin] (a share of the
// size) leaves the transparent border macOS expects around app icons.
export function appIcon(logo, size, { margin = 0 } = {}) {
  const canvas = blankImage(size);
  const inset = size * margin;
  const side = size - 2 * inset;
  paintRoundedSquare(canvas, inset, side, side * CORNER_SHARE, BACKDROP);
  placeLogo(canvas, logo, Math.round(side * LOGO_SHARE));
  return canvas;
}

// The logo inside a light disc, with a [dot] colour status dot in a light ring at the lower right.
export function trayIcon(logo, size, dot) {
  const canvas = blankImage(size);
  const center = size / 2;
  paintDisc(canvas, center, center, size * 0.5, BACKDROP);
  placeLogo(canvas, logo, Math.round(size * LOGO_SHARE));
  // Large enough to read at 16 px, where the logo is mostly a shape.
  const radius = size * 0.25;
  const at = size - radius - size * 0.02;
  paintDisc(canvas, at, at, radius, DOT_RING);
  paintDisc(canvas, at, at, radius - Math.max(1, size * 0.06), dot);
  return canvas;
}

function placeLogo(canvas, logo, inner) {
  const offset = Math.round((canvas.width - inner) / 2);
  composite(canvas, resizeAverage(logo, inner), offset, offset);
}

// Each target pixel is the truncated mean of the source pixels it covers.
function resizeAverage(source, size) {
  if (size === source.width && size === source.height) return source;
  const target = blankImage(size);
  const dx = source.width / size;
  const dy = source.height / size;
  const span = (index, step) => {
    const from = Math.trunc(index * step);
    const to = Math.trunc((index + 1) * step);
    return [from, to === from ? to + 1 : to];
  };
  for (let y = 0; y < size; y++) {
    const [y1, y2] = span(y, dy);
    for (let x = 0; x < size; x++) {
      const [x1, x2] = span(x, dx);
      const sums = [0, 0, 0, 0];
      for (let sy = y1; sy < y2; sy++) {
        for (let sx = x1; sx < x2; sx++) {
          const at = (sy * source.width + sx) * 4;
          for (let c = 0; c < 4; c++) sums[c] += source.data[at + c];
        }
      }
      const inverse = 1 / ((y2 - y1) * (x2 - x1));
      const out = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) target.data[out + c] = Math.trunc(sums[c] * inverse);
    }
  }
  return target;
}

// Source-over blending of [layer] onto [canvas] at ([left], [top]).
function composite(canvas, layer, left, top) {
  for (let y = 0; y < layer.height; y++) {
    for (let x = 0; x < layer.width; x++) {
      const from = (y * layer.width + x) * 4;
      const overlayAlpha = layer.data[from + 3] / 255;
      if (overlayAlpha === 0) continue;
      const to = ((top + y) * canvas.width + left + x) * 4;
      const baseAlpha = canvas.data[to + 3] / 255;
      const inverse = 1 - overlayAlpha;
      const alpha = overlayAlpha + baseAlpha * inverse;
      const scale = alpha > 0 ? 1 / alpha : 0;
      for (let c = 0; c < 3; c++) {
        const mixed = ((layer.data[from + c] / 255) * overlayAlpha + (canvas.data[to + c] / 255) * baseAlpha * inverse) * scale;
        canvas.data[to + c] = toByte(mixed * 255);
      }
      canvas.data[to + 3] = toByte(alpha * 255);
    }
  }
}

function toByte(value) {
  return Math.trunc(Math.min(255, Math.max(0, value)));
}

function paintDisc(canvas, cx, cy, radius, rgb) {
  paint(canvas, cx - radius, cy - radius, 2 * radius, rgb, cx, cy, (dx, dy) => dx * dx + dy * dy <= radius * radius);
}

// A square of [side] at ([at], [at]) with corners of [radius].
function paintRoundedSquare(canvas, at, side, radius, rgb) {
  const center = at + side / 2;
  const half = side / 2 - radius;
  paint(canvas, at, at, side, rgb, center, center, (dx, dy) => {
    const ox = Math.max(Math.abs(dx) - half, 0);
    const oy = Math.max(Math.abs(dy) - half, 0);
    return ox * ox + oy * oy <= radius * radius;
  });
}

// Blends [rgb] over the [side]-square at ([left], [top]) by the share of
// SAMPLES x SAMPLES subpixels, offset from ([cx], [cy]), for which [inside] holds.
function paint(canvas, left, top, side, rgb, cx, cy, inside) {
  const colour = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
  const yEnd = Math.min(canvas.height, Math.ceil(top + side));
  const xEnd = Math.min(canvas.width, Math.ceil(left + side));
  for (let y = Math.max(0, Math.floor(top)); y < yEnd; y++) {
    for (let x = Math.max(0, Math.floor(left)); x < xEnd; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          if (inside(x + (sx + 0.5) / SAMPLES - cx, y + (sy + 0.5) / SAMPLES - cy)) covered++;
        }
      }
      if (covered === 0) continue;
      const alpha = covered / (SAMPLES * SAMPLES);
      const at = (y * canvas.width + x) * 4;
      const underAlpha = canvas.data[at + 3] / 255;
      const outAlpha = alpha + underAlpha * (1 - alpha);
      for (let c = 0; c < 3; c++) {
        canvas.data[at + c] = Math.round((colour[c] * alpha + canvas.data[at + c] * underAlpha * (1 - alpha)) / outAlpha);
      }
      canvas.data[at + 3] = Math.round(outAlpha * 255);
    }
  }
}
