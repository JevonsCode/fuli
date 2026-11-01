// The mark as data for clients that draw it themselves (the Flutter client, the
// console's loading): both optical cuts' layer paths on the 512 view box, the
// light and dark gold gradients, and the ink and white the layers are filled with.
import { isDeepStrictEqual } from 'node:util';

const SOLID_LAYERS = ['orbitUpper', 'wave', 'bar1', 'bar2', 'bar3'];

function cutPaths(light, dark, cut) {
  for (const [name, layer] of Object.entries(light.layers)) {
    if (layer.d !== dark.layers[name].d) throw new Error(`the ${cut} mark's ${name} differs between its light and dark files`);
  }
  const { orbitGold, orbitUpper, wave, bar1, bar2, bar3 } = light.layers;
  return { orbitGold: orbitGold.d, orbitUpper: orbitUpper.d, wave: wave.d, bars: [bar1.d, bar2.d, bar3.d] };
}

// The one colour every solid layer of [mark] has.
function solidFill(mark, name) {
  const fills = new Set(SOLID_LAYERS.map((layer) => mark.layers[layer].fill.toUpperCase()));
  if (fills.size !== 1) throw new Error(`the ${name} mark's solid layers use ${[...fills].join(', ')}`);
  return [...fills][0];
}

function sameOrThrow(values, what) {
  if (!values.every((value) => isDeepStrictEqual(value, values[0]))) throw new Error(`the marks disagree on ${what}`);
  return values[0];
}

// The desktop client's contract (desktop/flutter/assets/brand/fuli-mark.json): both cuts'
// layers, the light and dark gold stops as [offset, colour], and the ink and white.
// [marks]: readMarkSvg results for { master, masterDark, micro, microDark }.
export function markContract({ master, masterDark, micro, microDark }) {
  const stops = (mark) => mark.gradient.stops.map(({ offset, color }) => [offset, color]);
  return {
    master: cutPaths(master, masterDark, 'master'),
    micro: cutPaths(micro, microDark, 'micro'),
    gold: {
      light: sameOrThrow([master, micro].map(stops), 'the light gold'),
      dark: sameOrThrow([masterDark, microDark].map(stops), 'the dark gold')
    },
    ink: sameOrThrow([solidFill(master, 'master'), solidFill(micro, 'micro')], 'the ink'),
    white: sameOrThrow([solidFill(masterDark, 'dark master'), solidFill(microDark, 'dark micro')], 'the white')
  };
}

// The console's drawing data: the contract plus the view box, the gold gradient's
// line and [microBelowPx], the size under which the micro cut is drawn.
export function markDrawing(marks, microBelowPx) {
  const all = Object.values(marks);
  const viewBox = sameOrThrow(all.map(({ viewBox }) => viewBox), 'the view box').split(/\s+/).map(Number);
  const goldLine = sameOrThrow(all.map(({ gradient: { x1, y1, x2, y2 } }) => ({ x1, y1, x2, y2 })), 'the gradient line');
  return { ...markContract(marks), viewBox, goldLine, microBelowPx };
}
