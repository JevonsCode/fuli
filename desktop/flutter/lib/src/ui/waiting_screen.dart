import 'package:flutter/material.dart';

import 'growth_loading.dart';
import 'theme.dart';
import 'top_line.dart';

/// The window while FULI is being checked, started or opened: the top line's
/// mark where the status page keeps it, and the loading mark with what is
/// really happening now. Never a blank window.
class WaitingScreen extends StatelessWidget {
  const WaitingScreen({super.key, required this.label, this.detail});

  final String label;

  /// One small line under the mark when the step is taking long.
  final String? detail;

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
                padding: EdgeInsets.only(bottom: topLineExtent(context)),
                child: GrowthLoading(label: label, detail: detail, variant: GrowthLoadingVariant.page),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
