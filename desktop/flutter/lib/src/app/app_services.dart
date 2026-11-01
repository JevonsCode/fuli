import 'package:flutter/widgets.dart';

import '../l10n/strings.dart';
import '../platform/caption_controls.dart';
import '../platform/ports.dart';
import 'fuli_controller.dart';

/// What the composition root hands the window. [consoleView] shows the
/// console page inside the window and calls its second argument once the page
/// has loaded (or failed to); null where there is no WebView (the web preview,
/// a computer without the WebView runtime). [caption] is the window's own
/// caption (its buttons and title bar); null where the OS keeps its own (the web preview).
class AppServices {
  const AppServices(
      {required this.controller, required this.strings, required this.opener, this.consoleView, this.caption});

  final FuliController controller;
  final Strings strings;
  final UrlOpener opener;
  final Widget Function(Uri console, VoidCallback onLoaded)? consoleView;
  final CaptionControls? caption;
}
