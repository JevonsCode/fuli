// The characters an OpenType or TrueType font draws: the code points its
// Unicode cmap maps to a glyph other than .notdef. Reads the full-repertoire
// (format 12) subtable when the font has one, else the BMP (format 4) one.
const UNICODE_FULL = [[3, 10], [0, 4], [0, 6]];
const UNICODE_BMP = [[3, 1], [0, 3]];

function tableOffset(font, tag) {
  const tables = font.readUInt16BE(4);
  for (let at = 12; at < 12 + tables * 16; at += 16) {
    if (font.toString('latin1', at, at + 4) === tag) return font.readUInt32BE(at + 8);
  }
  throw new Error(`the font has no ${tag} table`);
}

function format12(font, at, codePoints) {
  const groups = font.readUInt32BE(at + 12);
  for (let group = at + 16; group < at + 16 + groups * 12; group += 12) {
    const [first, last, glyph] = [0, 4, 8].map((field) => font.readUInt32BE(group + field));
    for (let code = first; code <= last; code++) if (glyph + code - first !== 0) codePoints.add(code);
  }
}

function format4(font, at, codePoints) {
  const segments = font.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment++) {
    const [end, start, rangeOffset] = [ends, starts, rangeOffsets].map((array) => font.readUInt16BE(array + segment * 2));
    const delta = font.readInt16BE(deltas + segment * 2);
    for (let code = start; code <= end && code !== 0xffff; code++) {
      let glyph = code;
      if (rangeOffset !== 0) {
        glyph = font.readUInt16BE(rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2);
        if (glyph === 0) continue;
      }
      if ((glyph + delta) & 0xffff) codePoints.add(code);
    }
  }
}

/** The code points [font] (a Buffer of an OpenType or TrueType file) draws, as a Set. */
export function fontCharacters(font) {
  const cmap = tableOffset(font, 'cmap');
  const subtables = new Map();
  for (let record = 0; record < font.readUInt16BE(cmap + 2); record++) {
    const at = cmap + 4 + record * 8;
    subtables.set(`${font.readUInt16BE(at)},${font.readUInt16BE(at + 2)}`, cmap + font.readUInt32BE(at + 4));
  }
  const codePoints = new Set();
  const pick = (encodings, format) =>
    encodings.map(([platform, encoding]) => subtables.get(`${platform},${encoding}`))
      .find((at) => at !== undefined && font.readUInt16BE(at) === format);
  const full = pick(UNICODE_FULL, 12);
  if (full !== undefined) format12(font, full, codePoints);
  else {
    const bmp = pick(UNICODE_BMP, 4);
    if (bmp === undefined) throw new Error('the font has no Unicode cmap');
    format4(font, bmp, codePoints);
  }
  return codePoints;
}
