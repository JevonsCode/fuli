import '../app/app_services.dart';
import '../app/fuli_controller.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import '../platform/url_opener.dart';
import 'demo_fuli.dart';

/// Composition root of the web preview: the real window over a synthetic FULI
/// (a browser cannot send the Host header the console requires, and has no
/// tray). `?state=ok|needs|degraded|stopped|notfound|old` picks the scenario.
Future<AppServices> createServices(Strings strings) async {
  final (api, runtime) = demoScenario(Uri.base.queryParameters['state'] ?? 'needs');
  final controller = FuliController(
    apiFor: (_) => api,
    runtime: runtime,
    notifier: const _NoNotifier(),
    strings: strings,
  )..startPolling();
  return AppServices(controller: controller, strings: strings, opener: const BrowserUrlOpener());
}

class _NoNotifier implements Notifier {
  const _NoNotifier();

  @override
  Future<void> notify(String title, String body) async {}
}
