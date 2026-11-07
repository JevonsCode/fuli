import 'dart:convert';
import 'dart:io';

// FULI.app ships in a disk image (volume FULI: FULI.app and an Applications
// link). Opened from the image, or from the read-only copy macOS translocates
// a quarantined app to, it offers to move itself to Applications; opened from
// its place, it ejects a FULI installer image that is still mounted. Only
// images under /Volumes count: FULI's own updater mounts its images privately
// elsewhere (src/desktop/macos-app-update.js) and they are never touched.

const _shell = '/bin/sh';
const _mountedImages = '/usr/bin/hdiutil info -plist | /usr/bin/plutil -convert json -o - -';
const _hdiutil = '/usr/bin/hdiutil';
const _plutil = '/usr/bin/plutil';
const _ditto = '/usr/bin/ditto';
const _xattr = '/usr/bin/xattr';
const _open = '/usr/bin/open';
const _test = '/bin/test';
const _appName = 'FULI.app';
const _volumes = '/Volumes/';
const _translocated = '/AppTranslocation/';
// The instance opened from the image may still be closing: detach is tried
// again for about ten seconds, then left alone.
const _ejectAttempts = 5;
const _ejectPause = Duration(milliseconds: 2500);

typedef CommandRunner = Future<ProcessResult> Function(String executable, List<String> arguments);

/// Where the running FULI.app was opened from.
enum InstallPlace { inPlace, installer, translocated }

class MacosInstallPlace {
  MacosInstallPlace({
    required this.bundle,
    required this.home,
    this.applications = '/Applications',
    CommandRunner run = Process.run,
    Future<void> Function(Duration) pause = Future<void>.delayed,
    DateTime Function() now = DateTime.now,
  })  : _runner = run,
        _pause = pause,
        _now = now;

  /// The running app: the executable is FULI.app/Contents/MacOS/FULI.
  factory MacosInstallPlace.running() => MacosInstallPlace(
      bundle: File(Platform.resolvedExecutable).parent.parent.parent.path, home: Platform.environment['HOME'] ?? '');

  final String bundle;
  final String home;
  final String applications;
  final CommandRunner _runner;
  final Future<void> Function(Duration) _pause;
  final DateTime Function() _now;

  Future<InstallPlace> place() async {
    if (bundle.contains(_translocated)) return InstallPlace.translocated;
    return (await _mounts()).any(_holdsApp) ? InstallPlace.installer : InstallPlace.inPlace;
  }

  /// Ejects every mounted FULI installer image (one holding a FULI.app with
  /// this app's bundle identifier), never the one this app runs from. Gives
  /// up quietly; the downloaded .dmg file is never touched.
  Future<void> ejectInstallers() async {
    final identifier = await _bundleIdentifier(bundle);
    if (identifier == null) return;
    for (final mount in await _mounts()) {
      if (_holdsApp(mount) || await _bundleIdentifier('$mount/$_appName') != identifier) continue;
      await _detach(mount);
    }
  }

  /// Copies this app to Applications (~/Applications when /Applications is
  /// not writable) and opens the copy; a FULI already there that is as new or
  /// newer is opened instead, an older one goes to the Trash. False when it
  /// could not: nothing is left behind and the person goes on from here.
  Future<bool> moveToApplications() async {
    final folder = await _succeeds(_test, ['-w', applications]) ? applications : '$home/Applications';
    final destination = '$folder/$_appName';
    final existing = Directory(destination).existsSync();
    if (existing && _compareVersions(await _version(destination), await _version(bundle)) >= 0) {
      // Opened from a quarantined place, it would be translocated again.
      await _run(_xattr, ['-d', '-r', 'com.apple.quarantine', destination]);
      return _succeeds(_open, ['-n', destination]);
    }
    final staging = '$folder/.FULI-moving-$pid.app';
    try {
      Directory(folder).createSync(recursive: true);
      if (!await _succeeds(_ditto, ['--noqtn', bundle, staging])) return false;
      if (existing) Directory(destination).renameSync(_trashPlace());
      Directory(staging).renameSync(destination);
    } on FileSystemException {
      return false;
    } finally {
      _remove(staging);
    }
    return _succeeds(_open, ['-n', destination]);
  }

  bool _holdsApp(String mount) => bundle.startsWith('$mount/');

  Future<void> _detach(String mount) async {
    for (var attempt = 1; attempt <= _ejectAttempts; attempt++) {
      if (await _succeeds(_hdiutil, ['detach', mount])) return;
      if (attempt < _ejectAttempts) await _pause(_ejectPause);
    }
  }

  // The mount points of the mounted disk images that show under /Volumes.
  Future<List<String>> _mounts() async {
    final info = _jsonObject((await _run(_shell, ['-c', _mountedImages]))?.stdout);
    final images = info?['images'];
    return [
      if (images is List)
        for (final image in images.whereType<Map>())
          if (image['system-entities'] case final List entities)
            for (final entity in entities.whereType<Map>())
              if (entity['mount-point'] case final String mount when mount.startsWith(_volumes)) mount,
    ];
  }

  Future<String?> _bundleIdentifier(String app) async =>
      switch ((await _plist('$app/Contents/Info.plist'))?['CFBundleIdentifier']) { final String id => id, _ => null };

  // FULI's own version inside the app; the client's bundle version for one built without FULI.
  Future<(String, String)> _version(String app) async {
    try {
      final package = _jsonObject(File('$app/Contents/Resources/fuli/package.json').readAsStringSync());
      if (package?['version'] case final String version) return (version, '');
    } on FileSystemException {
      // No FULI inside: the client's version below.
    }
    final info = await _plist('$app/Contents/Info.plist');
    return ('${info?['CFBundleShortVersionString'] ?? ''}', '${info?['CFBundleVersion'] ?? ''}');
  }

  Future<Map<String, Object?>?> _plist(String path) async {
    final converted = await _run(_plutil, ['-convert', 'json', '-o', '-', path]);
    return converted?.exitCode == 0 ? _jsonObject(converted!.stdout) : null;
  }

  String _trashPlace() {
    final at = _now();
    String two(int value) => value.toString().padLeft(2, '0');
    return '$home/.Trash/FULI ${at.year}-${two(at.month)}-${two(at.day)} '
        '${two(at.hour)}.${two(at.minute)}.${two(at.second)}.app';
  }

  void _remove(String path) {
    try {
      final directory = Directory(path);
      if (directory.existsSync()) directory.deleteSync(recursive: true);
    } on FileSystemException {
      // A copy left half-made only takes space; the next move replaces it.
    }
  }

  Future<bool> _succeeds(String executable, List<String> arguments) async =>
      (await _run(executable, arguments))?.exitCode == 0;

  Future<ProcessResult?> _run(String executable, List<String> arguments) async {
    try {
      return await _runner(executable, arguments);
    } on ProcessException {
      return null;
    }
  }
}

Map<String, Object?>? _jsonObject(Object? text) {
  if (text is! String) return null;
  try {
    final value = jsonDecode(text);
    return value is Map<String, Object?> ? value : null;
  } on FormatException {
    return null;
  }
}

// Semantic versions (0.24.0-beta.3 < 0.24.0), then the build number.
int _compareVersions((String, String) a, (String, String) b) {
  final byVersion = _compareSemver(a.$1, b.$1);
  return byVersion != 0 ? byVersion : _compareIdentifiers(a.$2.split('.'), b.$2.split('.'));
}

int _compareSemver(String a, String b) {
  (List<String>, String?) parts(String version) {
    final plain = version.split('+').first;
    final dash = plain.indexOf('-');
    return dash < 0 ? (plain.split('.'), null) : (plain.substring(0, dash).split('.'), plain.substring(dash + 1));
  }

  final (aCore, aPre) = parts(a);
  final (bCore, bPre) = parts(b);
  final byCore = _compareIdentifiers(aCore, bCore);
  if (byCore != 0 || aPre == bPre) return byCore;
  if (aPre == null) return 1;
  if (bPre == null) return -1;
  return _compareIdentifiers(aPre.split('.'), bPre.split('.'));
}

// Numbers compare as numbers, words as text; a missing or empty part counts as 0.
int _compareIdentifiers(List<String> a, List<String> b) {
  String at(List<String> parts, int index) => index < parts.length && parts[index].isNotEmpty ? parts[index] : '0';
  for (var index = 0; index < a.length || index < b.length; index++) {
    final (left, right) = (at(a, index), at(b, index));
    final (leftNumber, rightNumber) = (int.tryParse(left), int.tryParse(right));
    final order = leftNumber != null && rightNumber != null
        ? leftNumber.compareTo(rightNumber)
        : (leftNumber != null ? -1 : (rightNumber != null ? 1 : left.compareTo(right)));
    if (order != 0) return order;
  }
  return 0;
}
