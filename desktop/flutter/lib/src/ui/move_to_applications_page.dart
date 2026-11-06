import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../platform/caption_controls.dart';
import 'brand.dart';
import 'growth_loading.dart';
import 'theme.dart';
import 'top_line.dart';
import 'window_caption.dart';

const _art = 112.0;
// Wide enough for the move button and its loading label in both languages,
// so the slot keeps its place when one replaces the other.
const _primaryWidth = 240.0;
const _noticeHeight = 20.0;

/// The window on macOS when FULI.app was opened from its disk image: the app
/// icon, an arrow and the Applications folder, one button to move it there
/// and a quiet one to go on from here. It runs before the client itself.
class MoveToApplicationsApp extends StatelessWidget {
  const MoveToApplicationsApp({
    super.key,
    required this.strings,
    required this.brand,
    required this.onMove,
    required this.onNotNow,
    this.caption,
  });

  final Strings strings;
  final FuliBrand brand;
  // True when the moved app is opening; false shows that it could not move.
  final Future<bool> Function() onMove;
  final VoidCallback onNotNow;
  final CaptionControls? caption;

  @override
  Widget build(BuildContext context) {
    final page = _MoveToApplicationsPage(strings: strings, onMove: onMove, onNotNow: onNotNow);
    final caption = this.caption;
    return MaterialApp(
      title: strings.appName,
      debugShowCheckedModeBanner: false,
      theme: fuliTheme(),
      builder: (context, child) => FuliBrandScope(brand: brand, child: child!),
      home: caption == null ? page : WindowChrome(caption: caption, strings: strings, child: page),
    );
  }
}

class _MoveToApplicationsPage extends StatefulWidget {
  const _MoveToApplicationsPage({required this.strings, required this.onMove, required this.onNotNow});

  final Strings strings;
  final Future<bool> Function() onMove;
  final VoidCallback onNotNow;

  @override
  State<_MoveToApplicationsPage> createState() => _MoveToApplicationsPageState();
}

class _MoveToApplicationsPageState extends State<_MoveToApplicationsPage> {
  var _moving = false;
  var _failed = false;

  Future<void> _move() async {
    setState(() {
      _moving = true;
      _failed = false;
    });
    final moved = await widget.onMove();
    if (!mounted || moved) return;
    setState(() {
      _moving = false;
      _failed = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final strings = widget.strings;
    return Scaffold(
      backgroundColor: FuliColors.bg,
      body: Column(
        children: [
          const TopLine(),
          Expanded(
            child: Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: topLineExtent(context)),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const _MoveArt(),
                    const SizedBox(height: FuliSpace.space10),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: _primaryWidth,
                          height: FuliSize.controlHeight,
                          child: _moving
                              ? Center(child: GrowthLoading(label: strings.movingToApplications))
                              : FilledButton.icon(
                                  key: const Key('move-to-applications'),
                                  onPressed: _move,
                                  icon: const Icon(Icons.drive_file_move_rounded, size: 18),
                                  label: Text(strings.moveToApplications),
                                ),
                        ),
                        const SizedBox(width: FuliSpace.space3),
                        TextButton(
                          key: const Key('not-now'),
                          style: TextButton.styleFrom(
                              minimumSize: const Size(0, FuliSize.controlHeight),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                          onPressed: _moving ? null : widget.onNotNow,
                          child: Text(strings.notNow),
                        ),
                      ],
                    ),
                    const SizedBox(height: FuliSpace.space3),
                    // Kept even when empty, so nothing above moves when it shows.
                    SizedBox(
                      height: _noticeHeight,
                      child: _failed
                          ? Semantics(
                              liveRegion: true,
                              child: Text(strings.moveFailed,
                                  key: const Key('move-failed'),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TypeScale.secondary.copyWith(color: Tone.problem.ink)),
                            )
                          : null,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// FULI's app icon → the Applications folder; the button says it in words.
class _MoveArt extends StatelessWidget {
  const _MoveArt();

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Image.asset('assets/app/fuli.png', width: _art, height: _art),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: FuliSpace.space6),
            child: Icon(Icons.arrow_forward_rounded, size: 40, color: FuliColors.faint),
          ),
          const SizedBox.square(
            dimension: _art,
            child: Stack(
              alignment: Alignment(0, .2),
              children: [
                Icon(Icons.folder_rounded, size: _art, color: FuliColors.chartBlue),
                Icon(Icons.apps_rounded, size: _art * .36, color: FuliColors.onAccent),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
