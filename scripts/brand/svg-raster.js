// Draws a FULI mark (readMarkSvg) at a pixel size: each layer's path is
// flattened to polygons and filled by non-zero winding, with horizontally exact
// and vertically supersampled coverage, in its solid colour or its gold gradient.
import { blankImage, blendPixel } from './raster.js';

const ROWS_PER_PIXEL = 16;
const CURVE_SEGMENTS = 24;
// The largest gap, in view box units, between an arc and its chords.
const ARC_TOLERANCE = 0.2;

export function renderMark(mark, size) {
  const [, , viewWidth] = mark.viewBox.split(/\s+/).map(Number);
  const scale = size / viewWidth;
  const image = blankImage(size);
  for (const layer of Object.values(mark.layers)) {
    const coverage = fillCoverage(flattenPath(layer.d), size, scale);
    const colourAt = layer.fill.startsWith('url(') ? gradientColour(mark.gradient, scale) : () => hexColour(layer.fill);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const share = Math.min(1, coverage[y * size + x]);
        if (share > 0) blendPixel(image, (y * size + x) * 4, colourAt(x + 0.5, y + 0.5), share);
      }
    }
  }
  return image;
}

function hexColour(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

// A linear gradient in view box units (gradientUnits="userSpaceOnUse", padded ends).
function gradientColour({ x1, y1, x2, y2, stops }, scale) {
  const colours = stops.map(({ offset, color }) => ({ offset, rgb: hexColour(color) }));
  const [dx, dy] = [x2 - x1, y2 - y1];
  const length = dx * dx + dy * dy;
  return (px, py) => {
    const t = Math.min(1, Math.max(0, ((px / scale - x1) * dx + (py / scale - y1) * dy) / length));
    const after = colours.findIndex(({ offset }) => offset >= t);
    if (after <= 0) return colours[after === 0 ? 0 : colours.length - 1].rgb;
    const [from, to] = [colours[after - 1], colours[after]];
    const mix = (t - from.offset) / (to.offset - from.offset);
    return from.rgb.map((channel, c) => channel + (to.rgb[c] - channel) * mix);
  };
}

// The closed polygons of absolute M, L, C, Q, A and Z path data.
export function flattenPath(d) {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  const polygons = [];
  let polygon = [];
  let at = 0;
  const number = () => Number(tokens[at++]);
  const current = () => polygon[polygon.length - 1];
  const close = () => {
    if (polygon.length > 2) polygons.push(polygon);
    polygon = [];
  };
  while (at < tokens.length) {
    const command = tokens[at++];
    if (command === 'Z') {
      const start = polygon[0];
      close();
      if (start) polygon = [start];
      continue;
    }
    if (command === 'M') {
      close();
      polygon = [[number(), number()]];
      continue;
    }
    if (command === 'L') polygon.push([number(), number()]);
    else if (command === 'C') {
      const points = [current(), [number(), number()], [number(), number()], [number(), number()]];
      polygon.push(...bezier(points));
    } else if (command === 'Q') {
      const points = [current(), [number(), number()], [number(), number()]];
      polygon.push(...bezier(points));
    } else if (command === 'A') {
      const [rx, ry, rotation, large, sweep, x, y] = Array.from({ length: 7 }, number);
      polygon.push(...arc(current(), rx, ry, rotation, large, sweep, [x, y]));
    } else {
      throw new Error(`the mark path uses "${command}"; only absolute M, L, C, Q, A and Z are drawn`);
    }
  }
  close();
  return polygons;
}

// Points along a quadratic or cubic Bézier curve, after its first point.
function bezier(points) {
  const result = [];
  for (let step = 1; step <= CURVE_SEGMENTS; step++) {
    let level = points;
    const t = step / CURVE_SEGMENTS;
    while (level.length > 1) {
      level = level.slice(1).map((point, index) => [
        level[index][0] + (point[0] - level[index][0]) * t,
        level[index][1] + (point[1] - level[index][1]) * t
      ]);
    }
    result.push(level[0]);
  }
  return result;
}

// Points along an SVG elliptical arc, after its start (SVG 1.1 implementation notes, F.6.5).
function arc([fromX, fromY], rx, ry, rotation, large, sweep, [toX, toY]) {
  if (rx === 0 || ry === 0) return [[toX, toY]];
  const phi = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const [hx, hy] = [(fromX - toX) / 2, (fromY - toY) / 2];
  const x1 = cos * hx + sin * hy;
  const y1 = -sin * hx + cos * hy;
  [rx, ry] = [Math.abs(rx), Math.abs(ry)];
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) [rx, ry] = [rx * Math.sqrt(lambda), ry * Math.sqrt(lambda)];
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const [cx1, cy1] = [(factor * rx * y1) / ry, (-factor * ry * x1) / rx];
  const [cx, cy] = [cos * cx1 - sin * cy1 + (fromX + toX) / 2, sin * cx1 + cos * cy1 + (fromY + toY) / 2];
  const start = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx);
  let delta = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - start;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const radius = Math.max(rx, ry);
  const stepAngle = radius > ARC_TOLERANCE ? 2 * Math.acos(1 - ARC_TOLERANCE / radius) : Math.PI / 2;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / stepAngle));
  const points = [];
  for (let step = 1; step < segments; step++) {
    const angle = start + (delta * step) / segments;
    const [ex, ey] = [rx * Math.cos(angle), ry * Math.sin(angle)];
    points.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
  }
  points.push([toX, toY]);
  return points;
}

// The share of each pixel of a [size] square the [polygons] (view box units, times [scale]) cover.
function fillCoverage(polygons, size, scale) {
  const edges = polygons.flatMap((points) => points.map((from, index) => {
    const to = points[(index + 1) % points.length];
    return [from[0] * scale, from[1] * scale, to[0] * scale, to[1] * scale];
  })).filter(([, y0, , y1]) => y0 !== y1);
  const coverage = new Float64Array(size * size);
  const rowShare = 1 / ROWS_PER_PIXEL;
  for (let py = 0; py < size; py++) {
    for (let row = 0; row < ROWS_PER_PIXEL; row++) {
      const y = py + (row + 0.5) * rowShare;
      const crossings = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
          crossings.push([x0 + ((y - y0) * (x1 - x0)) / (y1 - y0), y1 > y0 ? 1 : -1]);
        }
      }
      crossings.sort((a, b) => a[0] - b[0]);
      let winding = 0;
      let spanStart = 0;
      for (const [x, direction] of crossings) {
        const before = winding;
        winding += direction;
        if (before === 0 && winding !== 0) spanStart = x;
        else if (before !== 0 && winding === 0) addSpan(coverage, py * size, size, spanStart, x, rowShare);
      }
    }
  }
  return coverage;
}

function addSpan(coverage, rowStart, size, from, to, share) {
  const [left, right] = [Math.max(0, from), Math.min(size, to)];
  for (let x = Math.floor(left); x < Math.ceil(right); x++) {
    coverage[rowStart + x] += (Math.min(right, x + 1) - Math.max(left, x)) * share;
  }
}
