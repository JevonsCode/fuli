import 'package:flutter/material.dart';

import 'growth_loading.dart';
import 'theme.dart';
import 'top_line.dart';

/// The window while FULI is being checked, started or opened: the top line's
/// mark where the status page keeps it, and the loading mark with what is
/// really happening now. Never a blank window.
class WaitingScreen extends StatelessWidget {
  const WaitingScreen({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FuliColors.bg,
      body: Column(
        children: [
          const TopLine(),
          Expanded(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.only(bottom: topLineHeight),
                child: GrowthLoading(label: label, variant: GrowthLoadingVariant.page),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
