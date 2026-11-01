// Reads a FULI wordmark SVG (brand/svg/wordmark/*.svg) as data for clients that
// draw it themselves: the view box in the paths' own coordinates (the group's
// translate folded in) and every path's data, all in the group's one fill.
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));

function translation(transform = '') {
  if (!transform.trim()) return [0, 0];
  const match = /^\s*translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)\s*$/.exec(transform);
  if (!match) throw new Error(`the wordmark's group transform "${transform}" is not a plain translate`);
  return [Number(match[1]), Number(match[2])];
}

// { viewBox: [x, y, width, height], paths: [d, …], fill: '#RRGGBB' }
export function readWordmarkSvg(svg) {
  const [x, y, width, height] = attributes(svg.match(/<svg\b[^>]*>/)[0]).viewBox.split(/\s+/).map(Number);
  const groups = [...svg.matchAll(/<g\b[^>]*>/g)].map(([tag]) => attributes(tag));
  if (groups.length !== 1 || !groups[0].fill) throw new Error('the wordmark is not one filled group');
  const [dx, dy] = translation(groups[0].transform);
  const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map(([tag]) => attributes(tag));
  if (!paths.length) throw new Error('the wordmark has no paths');
  if (paths.some((path) => path.fill || path.transform)) throw new Error('a wordmark path has its own fill or transform');
  return { viewBox: [x - dx, y - dy, width, height], paths: paths.map(({ d }) => d), fill: groups[0].fill.toUpperCase() };
}

// The desktop client's wordmarks (desktop/flutter/assets/brand/fuli-wordmark.json):
// zh (复利) and en (FULI), each { viewBox, paths }, drawn in the mark's [ink].
export function wordmarkContract(wordmarks, ink) {
  return Object.fromEntries(Object.entries(wordmarks).map(([language, { viewBox, paths, fill }]) => {
    if (fill !== ink) throw new Error(`the ${language} wordmark is filled ${fill}, not the logo ink ${ink}`);
    return [language, { viewBox, paths }];
  }));
}
