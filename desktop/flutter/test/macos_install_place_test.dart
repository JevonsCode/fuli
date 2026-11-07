import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/macos_install_place.dart';

// Where FULI.app was opened from, what it ejects and how it moves itself,
// over synthetic hdiutil/plutil answers and a temporary folder tree. No macOS
// command runs: the fake answers each one.

const _id = 'com.example.fuli';

class FakeMac {
  FakeMac({this.images = const [], Map<String, Map<String, Object?>>? plists})
      : plists = plists ?? {};

  // hdiutil info, as plutil converts it to JSON.
  List<Map<String, Object?>> images;
  final Map<String, Map<String, Object?>> plists;
  final List<List<String>> calls = [];
  int detachFailures = 0;
  bool applicationsWritable = true;
  bool dittoFails = false;

  static ProcessResult _answer(int code, [String stdout = '']) => ProcessResult(0, code, stdout, '');

  Future<ProcessResult> run(String executable, List<String> arguments) async {
    calls.add([executable, ...arguments]);
    switch (executable) {
      case '/bin/sh':
        return _answer(0, jsonEncode({'images': images}));
      case '/usr/bin/plutil':
        final plist = plists[arguments.last];
        return plist == null ? _answer(1) : _answer(0, jsonEncode(plist));
      case '/usr/bin/hdiutil':
        return _answer(detachFailures-- > 0 ? 16 : 0);
      case '/bin/test':
        return _answer(applicationsWritable ? 0 : 1);
      case '/usr/bin/ditto':
        if (dittoFails) {
          Directory(arguments.last).createSync(recursive: true);
          return _answer(1);
        }
        File('${arguments.last}/Contents/copied-from')
          ..createSync(recursive: true)
          ..writeAsStringSync(arguments[1]);
        return _answer(0);
      default:
        return _answer(0);
    }
  }

  List<List<String>> callsOf(String executable) => [
        for (final call in calls)
          if (call.first == executable) call.sublist(1),
      ];
}

Map<String, Object?> _image(String path, List<String> mounts) => {
      'image-path': path,
      'system-entities': [
        {'content-hint': 'GUID_partition_scheme', 'dev-entry': '/dev/disk4'},
        for (final mount in mounts) {'dev-entry': '/dev/disk4s1', 'mount-point': mount},
      ],
    };

Map<String, Object?> _info({String id = _id, String version = '0.1.0', String build = '1'}) =>
    {'CFBundleIdentifier': id, 'CFBundleShortVersionString': version, 'CFBundleVersion': build};

void main() {
  group('where the app was opened from', () {
    final images = [_image('/Users/someone/Downloads/fuli-macos-arm64-0.24.0.dmg', ['/Volumes/FULI'])];

    Future<InstallPlace> placeOf(String bundle, {List<Map<String, Object?>>? mounted}) =>
        MacosInstallPlace(bundle: bundle, home: '/Users/someone', run: FakeMac(images: mounted ?? images).run)
            .place();

    test('from Applications it is in place', () async {
      expect(await placeOf('/Applications/FULI.app'), InstallPlace.inPlace);
    });

    test('from the mounted installer image it offers to move', () async {
      expect(await placeOf('/Volumes/FULI/FULI.app'), InstallPlace.installer);
    });

    test('a volume whose name only starts the same is another place', () async {
      expect(await placeOf('/Volumes/FULI 2/FULI.app'), InstallPlace.inPlace);
    });

    test('a translocated copy offers to move', () async {
      expect(await placeOf('/private/var/folders/xy/T/AppTranslocation/0A1B/d/FULI.app'), InstallPlace.translocated);
    });

    test('an image mounted outside /Volumes (the updater\'s own) is not an installer place', () async {
      final private = [_image('/tmp/fuli-app-update/fuli.dmg', ['/private/tmp/fuli-app-update-x/volume'])];
      expect(await placeOf('/private/tmp/fuli-app-update-x/volume/FULI.app', mounted: private), InstallPlace.inPlace);
    });

    test('no answer from hdiutil leaves it in place', () async {
      final place = MacosInstallPlace(
          bundle: '/Applications/FULI.app',
          home: '/Users/someone',
          run: (executable, arguments) async => throw const ProcessException('/bin/sh', [], 'missing'));
      expect(await place.place(), InstallPlace.inPlace);
    });
  });

  group('ejecting installers', () {
    late FakeMac mac;
    late List<Duration> pauses;

    MacosInstallPlace install(String bundle) => MacosInstallPlace(
        bundle: bundle, home: '/Users/someone', run: mac.run, pause: (pause) async => pauses.add(pause));

    setUp(() {
      pauses = [];
      mac = FakeMac(images: [
        _image('/Users/someone/Downloads/fuli.dmg', ['/Volumes/FULI']),
        _image('/Users/someone/Downloads/other.dmg', ['/Volumes/Other']),
        _image('/Users/someone/Downloads/fuli-old.dmg', ['/Volumes/FULI 1']),
        _image('/tmp/update.dmg', ['/private/tmp/update/volume']),
      ], plists: {
        '/Applications/FULI.app/Contents/Info.plist': _info(),
        '/Volumes/FULI/FULI.app/Contents/Info.plist': _info(),
        '/Volumes/FULI 1/FULI.app/Contents/Info.plist': _info(version: '0.0.9'),
        '/Volumes/Other/FULI.app/Contents/Info.plist': _info(id: 'org.example.other'),
        '/private/tmp/update/volume/FULI.app/Contents/Info.plist': _info(),
      });
    });

    test('ejects every FULI installer under /Volumes and nothing else', () async {
      await install('/Applications/FULI.app').ejectInstallers();
      expect(mac.callsOf('/usr/bin/hdiutil'), [
        ['detach', '/Volumes/FULI'],
        ['detach', '/Volumes/FULI 1'],
      ]);
    });

    test('never ejects the image the app runs from', () async {
      mac.plists['/Volumes/FULI 1/FULI.app/Contents/Info.plist'] = _info();
      await install('/Volumes/FULI 1/FULI.app').ejectInstallers();
      expect(mac.callsOf('/usr/bin/hdiutil'), [
        ['detach', '/Volumes/FULI'],
      ]);
    });

    test('an image still in use is tried again for about ten seconds, then left', () async {
      mac.images = [mac.images.first];
      mac.detachFailures = 2;
      await install('/Applications/FULI.app').ejectInstallers();
      expect(mac.callsOf('/usr/bin/hdiutil'), hasLength(3));

      mac.calls.clear();
      pauses.clear();
      mac.detachFailures = 99;
      await install('/Applications/FULI.app').ejectInstallers();
      expect(mac.callsOf('/usr/bin/hdiutil'), hasLength(5));
      expect(pauses.fold(Duration.zero, (sum, pause) => sum + pause), const Duration(seconds: 10));
    });

    test('without its own bundle identifier it ejects nothing', () async {
      mac.plists.remove('/Applications/FULI.app/Contents/Info.plist');
      await install('/Applications/FULI.app').ejectInstallers();
      expect(mac.callsOf('/usr/bin/hdiutil'), isEmpty);
    });
  });

  group('moving to Applications', () {
    late Directory root;
    late FakeMac mac;
    late String source;
    late String applications;
    late String home;

    setUp(() {
      root = Directory.systemTemp.createTempSync('fuli-move-to-applications-');
      source = '${root.path}/Volumes/FULI/FULI.app';
      applications = '${root.path}/Applications';
      home = '${root.path}/home';
      Directory(applications).createSync();
      Directory('$home/.Trash').createSync(recursive: true);
      mac = FakeMac();
    });
    tearDown(() => root.deleteSync(recursive: true));

    void app(String path, {String? fuliVersion, Map<String, Object?>? info}) {
      Directory('$path/Contents').createSync(recursive: true);
      if (fuliVersion != null) {
        File('$path/Contents/Resources/fuli/package.json')
          ..createSync(recursive: true)
          ..writeAsStringSync(jsonEncode({'name': 'fuli', 'version': fuliVersion}));
      }
      if (info != null) mac.plists['$path/Contents/Info.plist'] = info;
    }

    MacosInstallPlace install() => MacosInstallPlace(
        bundle: source,
        home: home,
        applications: applications,
        run: mac.run,
        now: () => DateTime(2026, 11, 6, 9, 5, 7));

    List<String> leftovers(String folder) =>
        [for (final entry in Directory(folder).listSync()) entry.uri.pathSegments.where((s) => s.isNotEmpty).last];

    test('copies the app into a writable Applications folder and opens the copy', () async {
      app(source, fuliVersion: '0.24.0');
      expect(await install().moveToApplications(), isTrue);
      expect(File('$applications/FULI.app/Contents/copied-from').readAsStringSync(), source);
      expect(mac.callsOf('/usr/bin/ditto').single, ['--noqtn', source, '$applications/.FULI-moving-$pid.app']);
      expect(mac.callsOf('/usr/bin/open').single, ['-n', '$applications/FULI.app']);
      expect(leftovers(applications), ['FULI.app']);
    });

    test('without write access to /Applications it moves to ~/Applications', () async {
      app(source, fuliVersion: '0.24.0');
      mac.applicationsWritable = false;
      expect(await install().moveToApplications(), isTrue);
      expect(Directory('$home/Applications/FULI.app').existsSync(), isTrue);
      expect(Directory('$applications/FULI.app').existsSync(), isFalse);
      expect(mac.callsOf('/usr/bin/open').single, ['-n', '$home/Applications/FULI.app']);
    });

    test('an installed FULI as new or newer is opened instead, never replaced', () async {
      app(source, fuliVersion: '0.24.0-beta.3');
      for (final installed in ['0.24.0-beta.3', '0.24.0-beta.10', '0.24.0']) {
        mac.calls.clear();
        app('$applications/FULI.app', fuliVersion: installed);
        expect(await install().moveToApplications(), isTrue, reason: installed);
        expect(mac.callsOf('/usr/bin/ditto'), isEmpty, reason: installed);
        expect(mac.callsOf('/usr/bin/open').single, ['-n', '$applications/FULI.app']);
      }
      expect(leftovers('$home/.Trash'), isEmpty);
    });

    test('an older installed FULI goes to the Trash and the new one takes its place', () async {
      app(source, fuliVersion: '0.24.0');
      app('$applications/FULI.app', fuliVersion: '0.23.9');
      expect(await install().moveToApplications(), isTrue);
      expect(leftovers('$home/.Trash'), ['FULI 2026-11-06 09.05.07.app']);
      expect(File('$applications/FULI.app/Contents/copied-from').existsSync(), isTrue);
    });

    test('a client built without FULI compares its bundle version and build', () async {
      app(source, info: _info(version: '0.2.0', build: '12'));
      app('$applications/FULI.app', info: _info(version: '0.2.0', build: '9'));
      expect(await install().moveToApplications(), isTrue);
      expect(mac.callsOf('/usr/bin/ditto'), hasLength(1));

      mac.calls.clear();
      app('$applications/FULI.app', info: _info(version: '0.2.0', build: '12'));
      expect(await install().moveToApplications(), isTrue);
      expect(mac.callsOf('/usr/bin/ditto'), isEmpty);
    });

    test('a failed copy leaves no staging copy and opens nothing', () async {
      app(source, fuliVersion: '0.24.0');
      mac.dittoFails = true;
      expect(await install().moveToApplications(), isFalse);
      expect(leftovers(applications), isEmpty);
      expect(mac.callsOf('/usr/bin/open'), isEmpty);
    });

    test('an older FULI that cannot go to the Trash stops the move and stays', () async {
      app(source, fuliVersion: '0.24.0');
      app('$applications/FULI.app', fuliVersion: '0.23.0');
      Directory('$home/.Trash').deleteSync();
      expect(await install().moveToApplications(), isFalse);
      expect(leftovers(applications), ['FULI.app']);
      expect(File('$applications/FULI.app/Contents/copied-from').existsSync(), isFalse);
      expect(mac.callsOf('/usr/bin/open'), isEmpty);
    });
  });
}
