import 'package:flutter/material.dart';

import '../app/app_services.dart';
import 'brand.dart';
import 'home_page.dart';
import 'theme.dart';
import 'title_strip.dart';
import 'waiting_screen.dart';

class FuliApp extends StatelessWidget {
  const FuliApp({super.key, required this.services, required this.brand});

  final AppServices services;
  final FuliBrand brand;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: services.strings.appName,
      debugShowCheckedModeBanner: false,
      theme: fuliTheme(),
      builder: (context, child) => FuliBrandScope(brand: brand, chinese: services.strings.chinese, child: child!),
      home: _Window(services: services),
    );
  }
}

/// The console itself whenever it answers: its own banner already shows the
/// doctor's findings, repair, update and data-format confirmation. The status
/// page is for when there is no console to show: not started, not installed,
/// or not answering. While FULI is checked or started, and until the console
/// page has loaded over it, the window waits with the loading mark.
class _Window extends StatefulWidget {
  const _Window({required this.services});

  final AppServices services;

  @override
  State<_Window> createState() => _WindowState();
}

class _WindowState extends State<_Window> {
  // The console page that finished its first load in the window.
  Uri? _loaded;

  AppServices get _services => widget.services;

  @override
  void initState() {
    super.initState();
    _services.controller.addListener(_forgetClosedConsole);
  }

  @override
  void dispose() {
    _services.controller.removeListener(_forgetClosedConsole);
    super.dispose();
  }

  // A console that stops answering leaves the window; the next one loads anew.
  void _forgetClosedConsole() {
    if (_services.controller.snapshot?.reached != true) _loaded = null;
  }

  void _consoleLoaded(Uri console) {
    if (mounted && _loaded != console) setState(() => _loaded = console);
  }

  @override
  Widget build(BuildContext context) {
    final controller = _services.controller;
    final strings = _services.strings;
    final consoleView = _services.consoleView;
    final caption = _services.caption;
    final content = ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final snapshot = controller.snapshot;
        if (consoleView != null && snapshot?.reached == true) {
          final console = controller.consoleUri;
          final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
          return Scaffold(
            backgroundColor: FuliColors.bg,
            body: Stack(
              children: [
                Positioned.fill(child: consoleView(console, () => _consoleLoaded(console))),
                Positioned.fill(
                  child: AnimatedSwitcher(
                    duration: still ? Duration.zero : FuliMotion.medium,
                    child: _loaded == console
                        ? const SizedBox.shrink()
                        : WaitingScreen(label: strings.openingConsole),
                  ),
                ),
              ],
            ),
          );
        }
        if (snapshot == null) return WaitingScreen(label: strings.checking);
        final bringingUp = controller.bringingUp;
        if (bringingUp != null) {
          return WaitingScreen(label: controller.pending ?? bringingUp);
        }
        return HomePage(
            controller: controller,
            snapshot: snapshot,
            strings: strings,
            opener: _services.opener,
            consoleLink: consoleView == null);
      },
    );
    if (caption == null) return content;
    // The title strip stays where it is whatever the window shows below it.
    return Column(children: [TitleStrip(caption: caption, strings: strings), Expanded(child: content)]);
  }
}
