import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/link_inbox.dart';
import 'package:fuli_desktop/src/platform/fuli_link.dart';

// Handing fuli:// links from a second launch to the running client, in a
// temporary folder; the real %LOCALAPPDATA% is never touched.
void main() {
  late Directory temp;
  late LinkInbox inbox;

  setUp(() {
    temp = Directory.systemTemp.createTempSync('fuli-scheme-inbox-');
    inbox = LinkInbox(Directory('${temp.path}${Platform.pathSeparator}links'));
  });
  tearDown(() => temp.deleteSync(recursive: true));

  FuliLink link(String text) => FuliLink.parse(text)!;
  List<String> texts(List<FuliLink> links) => [for (final link in links) link.text];

  test('every link left is taken once, oldest first, even when the launches signalled once', () {
    expect(inbox.take(), isEmpty, reason: 'an inbox nobody wrote to is empty');
    var clock = DateTime(2026, 10, 31, 12);
    final writer = LinkInbox(inbox.directory, now: () => clock = clock.add(const Duration(milliseconds: 1)));
    for (final text in ['fuli://knowledge/a', 'fuli://status', 'fuli://projects/b?x=1']) {
      writer.put(link(text));
    }
    expect(texts(inbox.take()), ['fuli://knowledge/a', 'fuli://status', 'fuli://projects/b?x=1']);
    expect(inbox.take(), isEmpty);
  });

  test('only fuli:// links come out, whatever else is in the folder', () {
    inbox.put(link('fuli://knowledge/a'));
    final dir = inbox.directory.path;
    File('$dir${Platform.pathSeparator}00000000000000000001-1.link').writeAsStringSync('http://evil.example/');
    File('$dir${Platform.pathSeparator}00000000000000000002-1.link').writeAsStringSync('fuli://knowledge/../../x');
    File('$dir${Platform.pathSeparator}00000000000000000003-1.link').writeAsStringSync('fuli://knowledge/${'a' * 3000}');
    expect(texts(inbox.take()), ['fuli://knowledge/a']);
    expect(inbox.directory.listSync(), isEmpty, reason: 'refused links are removed too');
  });

  test('a write still in progress waits; stale links and abandoned writes are dropped', () {
    inbox.put(link('fuli://knowledge/fresh'));
    final dir = inbox.directory.path;
    final writing = File('$dir${Platform.pathSeparator}99999999999999999999-2.tmp')..writeAsStringSync('fuli://knowledge/next');
    final stale = File('$dir${Platform.pathSeparator}00000000000000000001-3.link')..writeAsStringSync('fuli://knowledge/old');
    final abandoned = File('$dir${Platform.pathSeparator}00000000000000000001-4.tmp')..writeAsStringSync('fuli://knowledge/x');
    final old = DateTime.now().subtract(const Duration(minutes: 6));
    stale.setLastModifiedSync(old);
    abandoned.setLastModifiedSync(old);
    expect(texts(inbox.take()), ['fuli://knowledge/fresh']);
    expect(writing.existsSync(), isTrue);
    expect(stale.existsSync() || abandoned.existsSync(), isFalse);
  });

  test('each client has its own inbox under LOCALAPPDATA', () {
    final a = LinkInbox.forInstance('aaaa', {'LOCALAPPDATA': r'C:\Users\a\AppData\Local'});
    final b = LinkInbox.forInstance('bbbb', {'LOCALAPPDATA': r'C:\Users\a\AppData\Local'});
    expect(a?.directory.path, r'C:\Users\a\AppData\Local\FULI Desktop\links\aaaa');
    expect(b?.directory.path, isNot(a?.directory.path));
    expect(LinkInbox.forInstance('aaaa', const {}), isNull);
  });
}
