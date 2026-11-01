// Whether two encoded images show the same thing. PNG compression differs between
// zlib builds, so generated PNGs and ICOs compare by their pixels, not their bytes.
import { decodeIco, isIco } from './ico.js';
import { decodePng, isPng } from './png.js';

export function sameBytes(a, b) {
  return a.equals(b);
}

export function samePixels(a, b) {
  if (isPng(a) && isPng(b)) return samePngPixels(a, b);
  if (!isIco(a) || !isIco(b)) return false;
  const left = decodeIco(a);
  const right = decodeIco(b);
  return left.length === right.length && left.every((entry, index) =>
    entry.size === right[index].size &&
    entry.bitCount === right[index].bitCount &&
    samePngPixels(entry.bytes, right[index].bytes));
}

function samePngPixels(a, b) {
  if (!isPng(a) || !isPng(b)) return false;
  const left = decodePng(a);
  const right = decodePng(b);
  return left.width === right.width && left.height === right.height &&
    Buffer.from(left.data).equals(Buffer.from(right.data));
}
