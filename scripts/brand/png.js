// Decodes and encodes the 8-bit PNGs the brand assets use, with node:zlib only.
// Images are { width, height, data } with data as straight (not premultiplied) RGBA bytes.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 2: 3, 6: 4 };
const RGBA_COLOR_TYPE = 6;
const PAETH_FILTER = 4;

export function isPng(bytes) {
  return bytes.length >= SIGNATURE.length && bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

export function decodePng(bytes) {
  if (!isPng(bytes)) throw new TypeError('Expected a PNG file');
  let header = null;
  const compressed = [];
  for (let at = SIGNATURE.length; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const channels = CHANNELS_BY_COLOR_TYPE[header?.colorType];
  if (!channels || header.depth !== 8 || header.interlace !== 0) {
    throw new TypeError('Brand PNGs must be 8-bit, non-interlaced RGB or RGBA');
  }
  const { width, height } = header;
  const pixels = unfilter(inflateSync(Buffer.concat(compressed)), width * channels, height, channels);
  return { width, height, data: channels === 4 ? pixels : rgbToRgba(pixels) };
}

export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    filtered[out] = PAETH_FILTER;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const left = i >= 4 ? data[at - 4] : 0;
      const up = y > 0 ? data[at - stride] : 0;
      const upLeft = i >= 4 && y > 0 ? data[at - stride - 4] : 0;
      filtered[out + 1 + i] = (data[at] - paeth(left, up, upLeft)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = RGBA_COLOR_TYPE;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function chunk(type, body) {
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), typed.length + 4);
  return out;
}

function unfilter(raw, stride, height, channels) {
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const left = i >= channels ? pixels[at - channels] : 0;
      const up = y > 0 ? pixels[at - stride] : 0;
      const upLeft = i >= channels && y > 0 ? pixels[at - stride - channels] : 0;
      const value = raw[y * (stride + 1) + 1 + i];
      pixels[at] = value + predictor(filter, left, up, upLeft);
    }
  }
  return pixels;
}

function predictor(filter, left, up, upLeft) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: return paeth(left, up, upLeft);
    default: throw new TypeError(`Unknown PNG filter ${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function rgbToRgba(rgb) {
  const rgba = new Uint8Array((rgb.length / 3) * 4);
  for (let from = 0, to = 0; from < rgb.length; from += 3, to += 4) {
    rgba[to] = rgb[from];
    rgba[to + 1] = rgb[from + 1];
    rgba[to + 2] = rgb[from + 2];
    rgba[to + 3] = 255;
  }
  return rgba;
}
