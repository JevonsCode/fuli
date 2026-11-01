import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/installed_package.dart';

// Which client registers itself with Windows, decided from a temporary
// installation layout: <root>\installation.json and <root>\versions\<id>\client.
// The paths join with a backslash, as on Windows.

void main() {
  late Directory root;

  setUp(() => root = Directory.systemTemp.createTempSync('fuli-installed-package-'));
  tearDown(() => root.deleteSync(recursive: true));

  String slot(String id, {bool installed = true}) {
    final package = '${root.path}\\versions\\$id';
    Directory('$package\\client').createSync(recursive: true);
    if (installed) File('$package\\installed-context.json').writeAsStringSync('{}');
    return package;
  }

  void record(String packageRoot, {String status = 'installed'}) => File('${root.path}\\installation.json')
      .writeAsStringSync(jsonEncode({'status': status, 'packageRoot': packageRoot}));

  test('the version the installation runs now registers itself', () async {
    final current = slot('new');
    record(current.toUpperCase());
    expect(await installedPackageRoot('$current\\client'), current, reason: 'Windows paths compare without case');
  }, skip: !Platform.isWindows);

  test('a version kept for rollback leaves the entries to the current one', () async {
    final kept = slot('old');
    record(slot('new'));
    expect(await installedPackageRoot('$kept\\client'), isNull);
  }, skip: !Platform.isWindows);

  test('a build or package outside an installation never registers', () async {
    final build = Directory('${root.path}\\build\\client')..createSync(recursive: true);
    expect(await installedPackageRoot(build.path), isNull, reason: 'a client build folder');
    final copy = slot('copy', installed: false);
    record(copy);
    expect(await installedPackageRoot('$copy\\client'), isNull, reason: 'a package that was never installed');
    final current = slot('new');
    File('${root.path}\\installation.json').deleteSync();
    expect(await installedPackageRoot('$current\\client'), isNull, reason: 'a slot without its installation record');
    record(current, status: 'switching');
    expect(await installedPackageRoot('$current\\client'), isNull, reason: 'an installation in the middle of a switch');
  }, skip: !Platform.isWindows);
}
