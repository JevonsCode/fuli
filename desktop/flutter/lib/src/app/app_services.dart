import 'package:flutter/widgets.dart';

import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'fuli_controller.dart';

/// What the composition root hands the window. [consoleView] shows the
/// console page inside the window; null where there is no WebView (the web
/// preview, a computer without the WebView runtime).
class AppServices {
  const AppServices({required this.controller, required this.strings, required this.opener, this.consoleView});

  final FuliController controller;
  final Strings strings;
  final UrlOpener opener;
  final Widget Function(Uri console)? consoleView;
}
