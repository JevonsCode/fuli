import 'dart:io';

import '../fuli_link.dart';

// fuli:// links on their way to the running client of one data directory.
// The OS starts a new client for each link; that launch leaves the link here,
// one file each, and then signals the running client (windows_instance.dart),
// which takes every link waiting. The events carry no payload and are shared
// with older versions and with updates, so the links travel beside them:
// a burst of launches whose signals coalesce loses none, and a link left
// while an update holds the lock is taken by the client the update reopens.
// Links older than [_lifetime] are dropped, not followed.

const _lifetime = Duration(minutes: 5);
const _suffix = '.link';
// A link is at most maxFuliLinkLength ASCII characters.
const _maxFileBytes = maxFuliLinkLength;

class LinkInbox {
  LinkInbox(this.directory, {DateTime Function() now = DateTime.now}) : _now = now;

  /// The inbox of the client of [instanceKey] (windows-controller.js
  /// `context`), beside the client's WebView2 data in %LOCALAPPDATA%; null
  /// without LOCALAPPDATA.
  static LinkInbox? forInstance(String instanceKey, Map<String, String> env) {
    final local = env['LOCALAPPDATA'];
    return local == null || local.isEmpty ? null : LinkInbox(Directory('$local\\FULI Desktop\\links\\$instanceKey'));
  }

  final Directory directory;
  final DateTime Function() _now;

  /// Leaves [link] for the running client. The file appears whole: written
  /// under another name, then renamed.
  void put(FuliLink link) {
    directory.createSync(recursive: true);
    final name = '${_now().microsecondsSinceEpoch.toString().padLeft(20, '0')}-$pid';
    final pending = File('${directory.path}${Platform.pathSeparator}$name.tmp');
    pending.writeAsStringSync(link.text, flush: true);
    pending.renameSync('${directory.path}${Platform.pathSeparator}$name$_suffix');
  }

  /// Every link waiting, oldest first, each removed as it is taken.
  List<FuliLink> take() {
    final List<File> files;
    try {
      files = directory.listSync(followLinks: false).whereType<File>().toList()..sort((a, b) => a.path.compareTo(b.path));
    } on FileSystemException {
      return const []; // nothing was ever left
    }
    final links = <FuliLink>[];
    final oldest = _now().subtract(_lifetime);
    for (final file in files) {
      try {
        if (!file.statSync().modified.isAfter(oldest)) {
          file.deleteSync(); // a stale link, or a write that never finished
          continue;
        }
        if (!file.path.endsWith(_suffix)) continue; // still being written
        final link = file.lengthSync() <= _maxFileBytes ? FuliLink.parse(file.readAsStringSync()) : null;
        file.deleteSync();
        if (link != null) links.add(link);
      } on FileSystemException {
        // Taken by another reader, or still held by its writer: leave it.
      }
    }
    return links;
  }
}
