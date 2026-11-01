import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../l10n/strings.dart';
import '../l10n/window_control_names.dart';
import '../platform/caption_controls.dart';
import 'theme.dart';

// Windows' caption button width and glyph size.
const _buttonWidth = 46.0;
const _glyphSize = 10.0;

/// The window's own title strip, in place of the OS's caption and above
/// everything the window shows: the console page and the status page start
/// below it, so nothing in it moves while they load. All of it moves the
/// window, a double click maximises or restores it and a right click opens the
/// window menu. Windows gets minimise, maximise and close on the right; macOS
/// keeps its traffic lights on the left. No title: the page below names FULI.
class TitleStrip extends StatelessWidget {
  const TitleStrip({super.key, required this.caption, required this.strings});

  final CaptionControls caption;
  final Strings strings;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: caption.height,
      child: ColoredBox(
        color: FuliColors.bg,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: GestureDetector(
                key: const Key('title-strip-drag'),
                behavior: HitTestBehavior.opaque,
                onPanStart: (_) => caption.startDragging(),
                onDoubleTap: caption.toggleMaximize,
                onSecondaryTapUp: (_) => caption.showWindowMenu(),
              ),
            ),
            if (caption.drawsButtons) ...[
              _CaptionButton(glyph: _Glyph.minimize, label: strings.minimizeWindow, onPressed: caption.minimize),
              ValueListenableBuilder(
                valueListenable: caption.maximized,
                builder: (context, maximized, _) => _CaptionButton(
                  glyph: maximized ? _Glyph.restore : _Glyph.maximize,
                  label: maximized ? strings.restoreWindow : strings.maximizeWindow,
                  onPressed: caption.toggleMaximize,
                  nativeState: caption.maximizeButtonState,
                  onPlaced: caption.placeMaximizeButton,
                ),
              ),
              _CaptionButton(glyph: _Glyph.close, label: strings.closeWindow, onPressed: caption.close),
            ],
          ],
        ),
      ),
    );
  }
}

enum _Glyph { minimize, maximize, restore, close }

class _CaptionButton extends StatefulWidget {
  const _CaptionButton(
      {required this.glyph, required this.label, required this.onPressed, this.nativeState, this.onPlaced});

  final _Glyph glyph;
  final String label;
  final Future<void> Function() onPressed;
  // The OS's own hover and press, where the OS owns the pointer over the button.
  final ValueListenable<NativeButtonState>? nativeState;
  final void Function(Rect button, Size window)? onPlaced;

  @override
  State<_CaptionButton> createState() => _CaptionButtonState();
}

class _CaptionButtonState extends State<_CaptionButton> {
  var _hovered = false;
  var _pressed = false;

  void _place(Size window) {
    if (!mounted) return;
    final box = context.findRenderObject();
    if (box is RenderBox && box.hasSize) widget.onPlaced!(box.localToGlobal(Offset.zero) & box.size, window);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.onPlaced != null) {
      final window = MediaQuery.sizeOf(context);
      WidgetsBinding.instance.addPostFrameCallback((_) => _place(window));
    }
    final nativeState = widget.nativeState;
    return Semantics(
      button: true,
      label: widget.label,
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTapDown: (_) => setState(() => _pressed = true),
          onTapUp: (_) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onPressed,
          child: nativeState == null
              ? _face(NativeButtonState.idle)
              : ValueListenableBuilder(valueListenable: nativeState, builder: (context, state, _) => _face(state)),
        ),
      ),
    );
  }

  Widget _face(NativeButtonState native) {
    final pressed = _pressed || native == NativeButtonState.pressed;
    final hovered = pressed || _hovered || native == NativeButtonState.hovered;
    final close = widget.glyph == _Glyph.close;
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final Color fill;
    if (close) {
      fill = FuliColors.danger.withValues(alpha: pressed ? .85 : (hovered ? 1 : 0));
    } else {
      fill = pressed ? FuliColors.border : FuliColors.surfaceHover.withValues(alpha: hovered ? 1 : 0);
    }
    return AnimatedContainer(
      key: Key('caption-${widget.glyph.name}'),
      duration: still ? Duration.zero : FuliMotion.fast,
      curve: FuliMotion.ease,
      width: _buttonWidth,
      color: fill,
      alignment: Alignment.center,
      child: CustomPaint(
        size: const Size.square(_glyphSize),
        painter: _GlyphPainter(widget.glyph, close && hovered ? FuliColors.onAccent : FuliColors.inkSoft),
      ),
    );
  }
}

/// Windows' caption glyphs as hairlines on a 10 x 10 box.
class _GlyphPainter extends CustomPainter {
  const _GlyphPainter(this.glyph, this.colour);

  final _Glyph glyph;
  final Color colour;

  @override
  void paint(Canvas canvas, Size size) {
    final pen = Paint()
      ..color = colour
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..strokeJoin = StrokeJoin.round;
    final s = size.width;
    const corner = Radius.circular(1.5);
    switch (glyph) {
      case _Glyph.minimize:
        canvas.drawLine(Offset(0, s / 2), Offset(s, s / 2), pen);
      case _Glyph.maximize:
        canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(.5, .5, s - 1, s - 1), corner), pen);
      case _Glyph.restore:
        canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTWH(.5, 2.5, s - 3, s - 3), corner), pen);
        canvas.drawPath(
            Path()
              ..moveTo(2.5, 2.5)
              ..lineTo(2.5, .5)
              ..lineTo(s - .5, .5)
              ..lineTo(s - .5, s - 2.5)
              ..lineTo(s - 2.5, s - 2.5),
            pen);
      case _Glyph.close:
        canvas
          ..drawLine(Offset.zero, Offset(s, s), pen)
          ..drawLine(Offset(s, 0), Offset(0, s), pen);
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter old) => old.glyph != glyph || old.colour != colour;
}
