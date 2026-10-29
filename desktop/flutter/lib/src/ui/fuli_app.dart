import 'package:flutter/material.dart';

import '../app/app_services.dart';
import 'home_page.dart';
import 'theme.dart';

class FuliApp extends StatelessWidget {
  const FuliApp({super.key, required this.services});

  final AppServices services;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FULI',
      debugShowCheckedModeBanner: false,
      theme: fuliTheme(),
      home: _Window(services: services),
    );
  }
}

/// The console itself whenever it answers: its own banner already shows the
/// doctor's findings, repair, update and data-format confirmation. The status
/// page is for when there is no console to show: not started, not installed,
/// or not answering.
class _Window extends StatelessWidget {
  const _Window({required this.services});

  final AppServices services;

  @override
  Widget build(BuildContext context) {
    final controller = services.controller;
    final consoleView = services.consoleView;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        if (consoleView != null && controller.snapshot?.reached == true) {
          return Scaffold(body: consoleView(controller.consoleUri));
        }
        return HomePage(
            controller: controller,
            strings: services.strings,
            opener: services.opener,
            consoleLink: consoleView == null);
      },
    );
  }
}
