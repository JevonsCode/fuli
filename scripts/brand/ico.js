// An ICO is a 6-byte header, one 16-byte entry per image, then the images;
// these embed PNGs, which Windows reads since Vista.
const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;
const ICON_TYPE = 1;
const LARGEST_SIZE_BYTE = 256;

// [pngs]: [{ size, bytes }], square images.
export function encodeIco(pngs) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(ICON_TYPE, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = HEADER_BYTES + ENTRY_BYTES * pngs.length;
  const entries = pngs.map(({ size, bytes }) => {
    const entry = Buffer.alloc(ENTRY_BYTES);
    entry[0] = size >= LARGEST_SIZE_BYTE ? 0 : size;
    entry[1] = size >= LARGEST_SIZE_BYTE ? 0 : size;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(bytes.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += bytes.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(({ bytes }) => bytes)]);
}

export function isIco(bytes) {
  return bytes.length >= HEADER_BYTES && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === ICON_TYPE;
}

// The entries' sizes and embedded image bytes.
export function decodeIco(bytes) {
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const at = HEADER_BYTES + ENTRY_BYTES * index;
    const offset = bytes.readUInt32LE(at + 12);
    return {
      size: bytes[at] || LARGEST_SIZE_BYTE,
      bitCount: bytes.readUInt16LE(at + 6),
      bytes: bytes.subarray(offset, offset + bytes.readUInt32LE(at + 8))
    };
  });
}
