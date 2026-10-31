import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/download_saver.dart';

// Exports the console hands over are saved in a temporary folder standing in
// for Downloads; the person's real folders and registry are never touched.
void main() {
  late Directory folder;
  setUp(() async => folder = await Directory.systemTemp.createTemp('fuli-download-test'));
  tearDown(() async => folder.delete(recursive: true));

  test('saves the text under its own name and never overwrites an earlier export', () async {
    final saver = DownloadSaver(folder: () async => folder);
    final first = await saver.save('fuli-deleted-Garden.json', '{"a":1}');
    final second = await saver.save('fuli-deleted-Garden.json', '{"a":2}');
    final third = await saver.save('notes', '# Notes');
    expect(first.path.endsWith('fuli-deleted-Garden.json'), isTrue);
    expect(second.path.endsWith('fuli-deleted-Garden (2).json'), isTrue);
    expect(third.path.endsWith('notes'), isTrue);
    expect(await first.readAsString(), '{"a":1}');
    expect(await second.readAsString(), '{"a":2}');
  });

  test('a suggested name is one plain file name', () {
    expect(safeFileName(r'..\..\Windows\evil.json'), 'evil.json');
    expect(safeFileName('../a/b:c?.md'), 'b-c-.md');
    expect(safeFileName('  ...  '), 'fuli-export');
    expect(safeFileName('${'x' * 200}.json').length, 120);
    expect(safeFileName('${'x' * 200}.json').endsWith('.json'), isTrue);
  });

  test('refuses text larger than any console export', () async {
    final saver = DownloadSaver(folder: () async => folder);
    expect(saver.save('big.json', 'x' * (DownloadSaver.maxCharacters + 1)), throwsA(isA<FileSystemException>()));
  });

  test('finds a moved Downloads folder in the registry and falls back to the profile', () async {
    const env = {'USERPROFILE': r'C:\Users\synthetic'};
    Future<ProcessResult> moved(List<String> args) async => ProcessResult(0, 0,
        '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n'
        '    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    D:\\Downloads\\%USERNAME%\r\n', '');
    expect((await downloadsFolder(run: moved, environment: {...env, 'USERNAME': 'synthetic'})).path,
        r'D:\Downloads\synthetic');
    Future<ProcessResult> missing(List<String> args) async => ProcessResult(0, 1, '', 'not found');
    expect((await downloadsFolder(run: missing, environment: env)).path, r'C:\Users\synthetic\Downloads');
  });
}
