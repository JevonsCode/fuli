import 'package:flutter/material.dart';

import 'theme.dart';

/// The one indicator for a running operation, with the label of what is
/// really being done. Announced as a live status; static when the system
/// asks for reduced motion.
class PendingLine extends StatelessWidget {
  const PendingLine({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            SizedBox.square(
              dimension: 14,
              child: still
                  ? const DecoratedBox(decoration: BoxDecoration(color: Palette.accent, shape: BoxShape.circle))
                  : const CircularProgressIndicator(strokeWidth: 2, color: Palette.accent),
            ),
            const SizedBox(width: 10),
            Flexible(child: Text(label, style: TypeScale.body)),
          ],
        ),
      ),
    );
  }
}
