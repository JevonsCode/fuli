import 'dart:ui';

import 'package:flutter/widgets.dart';

import 'theme.dart';

/// A bar pinned over the window's content, in the console dock's frosted
/// glass: what scrolls beneath is blurred, and a hairline separates it on the
/// side that faces the content.
class GlassBar extends StatelessWidget {
  const GlassBar({super.key, required this.height, required this.edge, required this.child});

  final double height;
  // The side that faces the content.
  final AxisDirection edge;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    const line = BorderSide(color: FuliGlass.edge);
    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: FuliGlass.blur, sigmaY: FuliGlass.blur),
        child: Container(
          height: height,
          padding: const EdgeInsets.symmetric(horizontal: FuliSpace.space8),
          decoration: BoxDecoration(
            color: FuliGlass.surface,
            border: Border(
              bottom: edge == AxisDirection.down ? line : BorderSide.none,
              top: edge == AxisDirection.up ? line : BorderSide.none,
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}
