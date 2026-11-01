// Reads a FULI mark SVG (brand/svg/mark/*.svg): its gold gradient and its six
// layers, named as the Flutter contract and the console name them.
const LAYERS = {
  'fuli-orbit-gold': 'orbitGold',
  'fuli-orbit-upper': 'orbitUpper',
  'fuli-wave': 'wave',
  'fuli-bar--1': 'bar1',
  'fuli-bar--2': 'bar2',
  'fuli-bar--3': 'bar3'
};

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));

// { viewBox, gradient: { id, x1, y1, x2, y2, stops: [{ offset, color }] }, layers: { orbitGold: { fill, d }, ... } }
export function readMarkSvg(svg) {
  const viewBox = attributes(svg.match(/<svg\b[^>]*>/)[0]).viewBox;
  const gradientTag = svg.match(/<linearGradient\b[^>]*>/);
  if (!gradientTag) throw new Error('the mark has no gold gradient');
  const { id, x1, y1, x2, y2 } = attributes(gradientTag[0]);
  const stops = [...svg.matchAll(/<stop\b[^>]*>/g)].map(([tag]) => {
    const stop = attributes(tag);
    return { offset: Number.parseFloat(stop.offset) / 100, color: stop['stop-color'].toUpperCase() };
  });
  const layers = {};
  for (const [tag] of svg.matchAll(/<path\b[^>]*>/g)) {
    const path = attributes(tag);
    const name = path.class.split(/\s+/).map((part) => LAYERS[part]).find(Boolean);
    if (!name) throw new Error(`the mark has an unknown layer "${path.class}"`);
    layers[name] = { fill: path.fill, d: path.d };
  }
  const missing = Object.values(LAYERS).filter((name) => !layers[name]);
  if (missing.length) throw new Error(`the mark lacks ${missing.join(', ')}`);
  return { viewBox, gradient: { id, x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2), stops }, layers };
}
