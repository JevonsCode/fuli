// Regenerates the client's icons from the FULI logo (site/assets/fuli-logo.png):
// - assets/tray/{ok,needs_person,broken}.{png,ico}: the logo on a light disc,
//   so it reads on light and dark taskbars and menu bars, with a green, amber
//   or red status dot in the lower right;
// - assets/app/fuli.png: the logo for Windows notifications;
// - windows/runner/resources/app_icon.ico: the client's and the Fuli.exe
//   launcher's icon (scripts/build-windows-tray.js);
// - macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_*.png.
// Run from desktop/flutter: dart run tool/make_icons.dart
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:image/image.dart' as img;

const _logo = '../../site/assets/fuli-logo.png';
const _status = {
  'ok': 0x1F9A76,
  'needs_person': 0xD08A1E,
  'broken': 0xC0453A,
};
// macOS shows the menu bar icon at 18 pt; 36 px keeps it sharp on Retina.
const _trayPng = 36;
// Windows draws tray icons at 16 px on 100 % scaling, up to 32 px at 200 %.
const _trayIco = [16, 20, 24, 32, 40, 48];
const _appIco = [16, 24, 32, 48, 64, 128, 256];
const _macApp = [16, 32, 64, 128, 256, 512, 1024];
const _backdrop = 0xFFFFFF;
const _ring = 0xFFFFFF;
const _samples = 4;

void main() {
  final logo = img.decodePng(File(_logo).readAsBytesSync());
  if (logo == null) throw StateError('Cannot read $_logo');
  Directory('assets/tray').createSync(recursive: true);
  Directory('assets/app').createSync(recursive: true);
  for (final MapEntry(key: name, value: rgb) in _status.entries) {
    File('assets/tray/$name.png').writeAsBytesSync(img.encodePng(_icon(logo, _trayPng, dot: rgb)));
    File('assets/tray/$name.ico').writeAsBytesSync(_ico([for (final size in _trayIco) _icon(logo, size, dot: rgb)]));
  }
  File('assets/app/fuli.png').writeAsBytesSync(img.encodePng(_icon(logo, 256)));
  File('windows/runner/resources/app_icon.ico').writeAsBytesSync(_ico([for (final size in _appIco) _icon(logo, size)]));
  for (final size in _macApp) {
    File('macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_$size.png').writeAsBytesSync(img.encodePng(_icon(logo, size)));
  }
}

// The logo inside a light disc; with [dot], a status dot in a light ring at the lower right.
img.Image _icon(img.Image logo, int size, {int? dot}) {
  final canvas = img.Image(width: size, height: size, numChannels: 4);
  final center = size / 2;
  _paintDisc(canvas, center, center, size * 0.5, _backdrop);
  final inner = (size * 0.74).round();
  final scaled = img.copyResize(logo, width: inner, height: inner, interpolation: img.Interpolation.average);
  img.compositeImage(canvas, scaled, dstX: ((size - inner) / 2).round(), dstY: ((size - inner) / 2).round());
  if (dot != null) {
    // Large enough to read at 16 px, where the logo is mostly a shape.
    final radius = size * 0.25;
    final at = size - radius - size * 0.02;
    _paintDisc(canvas, at, at, radius, _ring);
    _paintDisc(canvas, at, at, radius - math.max(1.0, size * 0.06), dot);
  }
  return canvas;
}

// An antialiased disc (supersampled coverage) blended over the canvas.
void _paintDisc(img.Image canvas, double cx, double cy, double radius, int rgb) {
  final r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, b = rgb & 0xFF;
  for (var y = math.max(0, (cy - radius).floor()); y < math.min(canvas.height, (cy + radius).ceil()); y++) {
    for (var x = math.max(0, (cx - radius).floor()); x < math.min(canvas.width, (cx + radius).ceil()); x++) {
      var inside = 0;
      for (var sy = 0; sy < _samples; sy++) {
        for (var sx = 0; sx < _samples; sx++) {
          final dx = x + (sx + 0.5) / _samples - cx;
          final dy = y + (sy + 0.5) / _samples - cy;
          if (dx * dx + dy * dy <= radius * radius) inside++;
        }
      }
      if (inside == 0) continue;
      final alpha = inside / (_samples * _samples);
      final under = canvas.getPixel(x, y);
      final underAlpha = under.a / 255;
      final outAlpha = alpha + underAlpha * (1 - alpha);
      int mix(int top, num bottom) => ((top * alpha + bottom * underAlpha * (1 - alpha)) / outAlpha).round();
      canvas.setPixelRgba(x, y, mix(r, under.r), mix(g, under.g), mix(b, under.b), (outAlpha * 255).round());
    }
  }
}

// An ICO whose images are PNGs (supported since Windows Vista).
Uint8List _ico(List<img.Image> images) {
  final pngs = [for (final image in images) img.encodePng(image)];
  final header = ByteData(6)
    ..setUint16(2, 1, Endian.little)
    ..setUint16(4, images.length, Endian.little);
  final out = BytesBuilder()..add(header.buffer.asUint8List());
  var offset = 6 + 16 * images.length;
  for (var i = 0; i < images.length; i++) {
    final size = images[i].width;
    final entry = ByteData(16)
      ..setUint8(0, size >= 256 ? 0 : size)
      ..setUint8(1, size >= 256 ? 0 : size)
      ..setUint16(4, 1, Endian.little) // planes
      ..setUint16(6, 32, Endian.little) // bits per pixel
      ..setUint32(8, pngs[i].length, Endian.little)
      ..setUint32(12, offset, Endian.little);
    out.add(entry.buffer.asUint8List());
    offset += pngs[i].length;
  }
  for (final png in pngs) {
    out.add(png);
  }
  return out.takeBytes();
}
