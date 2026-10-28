import 'package:url_launcher/url_launcher.dart';

import 'ports.dart';

/// Opens the console or the install page in the default browser.
class BrowserUrlOpener implements UrlOpener {
  const BrowserUrlOpener();

  @override
  Future<void> open(Uri uri) => launchUrl(uri, mode: LaunchMode.externalApplication);
}
