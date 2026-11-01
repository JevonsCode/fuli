import 'dart:ui';

final _token = RegExp(r'[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?');
const _arity = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'Q': 4, 'A': 7, 'Z': 0};

/// SVG path data as a Flutter [Path]: the M, L, H, V, C, Q, A and Z commands
/// the brand marks use, absolute or relative. Anything else is a
/// [FormatException], so a mark never draws half a shape.
Path parseSvgPath(String data) {
  final tokens = _token.allMatches(data).map((match) => match[0]!).toList();
  final path = Path();
  var at = 0;
  var point = Offset.zero;
  var start = Offset.zero;
  String? letter;
  while (at < tokens.length) {
    if (RegExp(r'[A-Za-z]').hasMatch(tokens[at])) letter = tokens[at++];
    final command = letter?.toUpperCase();
    final arity = _arity[command];
    if (command == null || arity == null) {
      throw FormatException('unsupported path command ${letter ?? tokens[at]}', data);
    }
    if (at + arity > tokens.length) throw FormatException('incomplete $letter', data);
    final values = [for (var index = 0; index < arity; index++) double.parse(tokens[at + index])];
    at += arity;
    final relative = letter != command;
    Offset absolute(double x, double y) => relative ? point + Offset(x, y) : Offset(x, y);
    switch (command) {
      case 'M':
        point = start = absolute(values[0], values[1]);
        path.moveTo(point.dx, point.dy);
        // Further pairs after a moveto are linetos.
        letter = relative ? 'l' : 'L';
      case 'L':
        point = absolute(values[0], values[1]);
        path.lineTo(point.dx, point.dy);
      case 'H':
        point = Offset(relative ? point.dx + values[0] : values[0], point.dy);
        path.lineTo(point.dx, point.dy);
      case 'V':
        point = Offset(point.dx, relative ? point.dy + values[0] : values[0]);
        path.lineTo(point.dx, point.dy);
      case 'C':
        final first = absolute(values[0], values[1]);
        final second = absolute(values[2], values[3]);
        point = absolute(values[4], values[5]);
        path.cubicTo(first.dx, first.dy, second.dx, second.dy, point.dx, point.dy);
      case 'Q':
        final control = absolute(values[0], values[1]);
        point = absolute(values[2], values[3]);
        path.quadraticBezierTo(control.dx, control.dy, point.dx, point.dy);
      case 'A':
        point = absolute(values[5], values[6]);
        path.arcToPoint(point,
            radius: Radius.elliptical(values[0], values[1]),
            rotation: values[2],
            largeArc: values[3] != 0,
            clockwise: values[4] != 0);
      case 'Z':
        point = start;
        path.close();
        // A number right after closepath has no command.
        letter = null;
    }
  }
  return path;
}
