import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../platform/caption_controls.dart';
import 'brand.dart';
import 'growth_loading.dart';
import 'theme.dart';
import 'top_line.dart';
import 'window_caption.dart';

const _art = 96.0;
// Wide enough for the button and its loading label in both languages, so the
// slot keeps its place when one replaces the other.
const _primaryWidth = 240.0;
const _noticeHeight = 20.0;

/// The window on Windows when this client runs from a version an update
/// replaced (a window left open, or a pin to an old version's program): it
/// says so and offers one button that opens the installed version and closes
/// this one. It runs instead of the client itself.
class OldVersionApp extends StatelessWidget {
  const OldVersionApp({super.key, required this.strings, required this.brand, required this.onOpenNew, this.caption});

  final Strings strings;
  final FuliBrand brand;
  // Resolves only when the new version could not be started (false); on
  // success this process ends.
  final Future<bool> Function() onOpenNew;
  final CaptionControls? caption;

  @override
  Widget build(BuildContext context) {
    final page = _OldVersionPage(strings: strings, onOpenNew: onOpenNew);
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

class _OldVersionPage extends StatefulWidget {
  const _OldVersionPage({required this.strings, required this.onOpenNew});

  final Strings strings;
  final Future<bool> Function() onOpenNew;

  @override
  State<_OldVersionPage> createState() => _OldVersionPageState();
}

class _OldVersionPageState extends State<_OldVersionPage> {
  var _opening = false;
  var _failed = false;

  Future<void> _open() async {
    setState(() {
      _opening = true;
      _failed = false;
    });
    final opened = await widget.onOpenNew();
    if (!mounted || opened) return;
    setState(() {
      _opening = false;
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
                    ExcludeSemantics(child: Image.asset('assets/app/fuli.png', width: _art, height: _art)),
                    const SizedBox(height: FuliSpace.space6),
                    Text(strings.oldVersionWindow, key: const Key('old-version'), style: TypeScale.title),
                    const SizedBox(height: FuliSpace.space6),
                    SizedBox(
                      width: _primaryWidth,
                      height: FuliSize.controlHeight,
                      child: _opening
                          ? Center(child: GrowthLoading(label: strings.openingNewVersion))
                          : FilledButton.icon(
                              key: const Key('open-new-version'),
                              onPressed: _open,
                              icon: const Icon(Icons.open_in_new_rounded, size: 18),
                              label: Text(strings.openNewVersion),
                            ),
                    ),
                    const SizedBox(height: FuliSpace.space3),
                    // Kept even when empty, so nothing above moves when it shows.
                    SizedBox(
                      height: _noticeHeight,
                      child: _failed
                          ? Semantics(
                              liveRegion: true,
                              child: Text(strings.openNewVersionFailed,
                                  key: const Key('open-new-version-failed'),
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
