import 'dart:async';

import 'console_link.dart';

/// Loads a page into the console view the window shows.
typedef ConsolePageLoader = Future<void> Function(Uri page);

/// Which console page the window's console view shows next. A page asked for
/// (a `fuli://` link) loads in the view that shows now; while no view shows
/// that console (FULI not started yet, the window on its status page, the
/// port changed), the next view starts at it. Only pages of the console a
/// view shows ever load in it.
class ConsoleNavigation {
  ({Uri console, ConsolePageLoader load})? _shown;
  Uri? _requested;

  /// The page a view of [console] starts at: the page asked for last, when it
  /// is one of [console]'s pages, otherwise [console] itself.
  Uri startPage(Uri console) {
    final requested = _requested;
    return requested != null && isConsolePage(requested, console) ? requested : console;
  }

  /// A view of [console] that started at [startedAt] is showing. A page asked
  /// for since it was built loads in it.
  void attach(Uri console, ConsolePageLoader load, {required Uri startedAt}) {
    _shown = (console: console, load: load);
    final requested = _requested;
    if (requested == null || !isConsolePage(requested, console)) return;
    _requested = null;
    if (requested != startedAt) unawaited(load(requested));
  }

  /// The view [load] belongs to has left the window.
  void detach(ConsolePageLoader load) {
    if (_shown?.load == load) _shown = null;
  }

  /// Opens [page] in the view that shows its console, or in the next one.
  Future<void> open(Uri page) async {
    final shown = _shown;
    if (shown == null || !isConsolePage(page, shown.console)) {
      _requested = page;
      return;
    }
    _requested = null;
    await shown.load(page);
  }
}
