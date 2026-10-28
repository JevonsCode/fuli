import 'dart:ui';

import 'package:flutter/widgets.dart';

import 'src/l10n/strings.dart';
import 'src/preview/preview_services.dart' if (dart.library.io) 'src/platform/desktop/desktop_services.dart';
import 'src/ui/fuli_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final strings = Strings.forLanguage(PlatformDispatcher.instance.locale.languageCode);
  runApp(FuliApp(services: await createServices(strings)));
}
