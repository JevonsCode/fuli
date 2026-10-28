import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'fuli_controller.dart';

/// What the composition root hands the window.
class AppServices {
  const AppServices({required this.controller, required this.strings, required this.opener});

  final FuliController controller;
  final Strings strings;
  final UrlOpener opener;
}
