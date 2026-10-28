// Regenerates assets/tray/*.png and *.ico: a status-coloured disc with a thin
// light ring so it reads on light and dark taskbars and menu bars.
// Run from desktop/flutter: dart run tool/make_tray_icons.dart
import 'dart:io';
import 'dart:typed_data';

const _icons = {
  'ok': 0x1F9A76,
  'needs_person': 0xD08A1E,
  'broken': 0xC0453A,
};
// macOS shows the menu bar icon at 18 pt; 36 px keeps it sharp on Retina.
const _pngSize = 36;
const _icoSizes = [16, 24, 32, 48];
const _samples = 4;

void main() {
  Directory('assets/tray').createSync(recursive: true);
  for (final MapEntry(key: name, value: rgb) in _icons.entries) {
    File('assets/tray/$name.png').writeAsBytesSync(_png(_pngSize, rgb));
    File('assets/tray/$name.ico').writeAsBytesSync(_ico([for (final size in _icoSizes) _png(size, rgb)], _icoSizes));
  }
}

// RGBA pixels: the disc in the status colour inside a light ring, antialiased by supersampling.
Uint8List _pixels(int size, int rgb) {
  final pixels = Uint8List(size * size * 4);
  final center = size / 2;
  final outer = size * 0.46;
  final inner = outer - (size >= 32 ? 2.0 : 1.0);
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var ring = 0;
      var disc = 0;
      for (var sy = 0; sy < _samples; sy++) {
        for (var sx = 0; sx < _samples; sx++) {
          final dx = x + (sx + 0.5) / _samples - center;
          final dy = y + (sy + 0.5) / _samples - center;
          final distance = dx * dx + dy * dy;
          if (distance <= inner * inner) {
            disc++;
          } else if (distance <= outer * outer) {
            ring++;
          }
        }
      }
      final total = _samples * _samples;
      final alpha = (disc + ring) / total;
      if (alpha == 0) continue;
      final discShare = disc / (disc + ring);
      int channel(int shift) => (((rgb >> shift) & 0xFF) * discShare + 0xFF * (1 - discShare)).round();
      final offset = (y * size + x) * 4;
      pixels[offset] = channel(16);
      pixels[offset + 1] = channel(8);
      pixels[offset + 2] = channel(0);
      pixels[offset + 3] = (alpha * 255).round();
    }
  }
  return pixels;
}

Uint8List _png(int size, int rgb) {
  final pixels = _pixels(size, rgb);
  final raw = BytesBuilder();
  for (var y = 0; y < size; y++) {
    raw.addByte(0); // filter: none
    raw.add(pixels.sublist(y * size * 4, (y + 1) * size * 4));
  }
  final header = ByteData(13)
    ..setUint32(0, size)
    ..setUint32(4, size)
    ..setUint8(8, 8) // bit depth
    ..setUint8(9, 6); // RGBA
  return (BytesBuilder()
        ..add([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        ..add(_chunk('IHDR', header.buffer.asUint8List()))
        ..add(_chunk('IDAT', Uint8List.fromList(zlib.encode(raw.takeBytes()))))
        ..add(_chunk('IEND', Uint8List(0))))
      .takeBytes();
}

Uint8List _chunk(String type, Uint8List data) {
  final typeBytes = Uint8List.fromList(type.codeUnits);
  final length = ByteData(4)..setUint32(0, data.length);
  final crc = ByteData(4)..setUint32(0, _crc32([...typeBytes, ...data]));
  return (BytesBuilder()
        ..add(length.buffer.asUint8List())
        ..add(typeBytes)
        ..add(data)
        ..add(crc.buffer.asUint8List()))
      .takeBytes();
}

int _crc32(List<int> bytes) {
  var crc = 0xFFFFFFFF;
  for (final byte in bytes) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320 : crc >> 1;
    }
  }
  return crc ^ 0xFFFFFFFF;
}

// An ICO whose images are PNGs (supported since Windows Vista).
Uint8List _ico(List<Uint8List> images, List<int> sizes) {
  final header = ByteData(6)
    ..setUint16(2, 1, Endian.little)
    ..setUint16(4, images.length, Endian.little);
  final out = BytesBuilder()..add(header.buffer.asUint8List());
  var offset = 6 + 16 * images.length;
  for (var i = 0; i < images.length; i++) {
    final entry = ByteData(16)
      ..setUint8(0, sizes[i] >= 256 ? 0 : sizes[i])
      ..setUint8(1, sizes[i] >= 256 ? 0 : sizes[i])
      ..setUint16(4, 1, Endian.little) // planes
      ..setUint16(6, 32, Endian.little) // bits per pixel
      ..setUint32(8, images[i].length, Endian.little)
      ..setUint32(12, offset, Endian.little);
    out.add(entry.buffer.asUint8List());
    offset += images[i].length;
  }
  for (final image in images) {
    out.add(image);
  }
  return out.takeBytes();
}
