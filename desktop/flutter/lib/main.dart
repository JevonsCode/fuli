import 'dart:ui';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'src/l10n/strings.dart';
import 'src/preview/preview_services.dart' if (dart.library.io) 'src/platform/desktop/desktop_services.dart';
import 'src/ui/brand.dart';
import 'src/ui/fuli_app.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  final strings = Strings.forLanguage(PlatformDispatcher.instance.locale.languageCode);
  // The brand is read before the first frame, so no frame lacks the mark.
  final brand = await FuliBrand.load(rootBundle);
  runApp(FuliApp(services: await createServices(strings, args), brand: brand));
}
