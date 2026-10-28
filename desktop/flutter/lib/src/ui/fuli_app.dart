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
      home: HomePage(controller: services.controller, strings: services.strings, opener: services.opener),
    );
  }
}
