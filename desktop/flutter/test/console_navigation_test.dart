import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/console_navigation.dart';
import 'package:fuli_desktop/src/platform/fuli_link.dart';

// 「在客户端打开」 in the console in a browser hands the page to the client
// as a fuli:// link; it opens in the window's console view.
void main() {
  final console = Uri.parse('http://127.0.0.1:3999/');
  Uri page(String link) => FuliLink.parse(link)!.consolePage(3999);

  late ConsoleNavigation navigation;
  late List<Uri> loaded;
  Future<void> load(Uri page) async => loaded.add(page);
  setUp(() {
    navigation = ConsoleNavigation();
    loaded = [];
  });

  test('a view that shows loads the page asked for', () async {
    expect(navigation.startPage(console), console);
    navigation.attach(console, load, startedAt: console);
    await navigation.open(page('fuli://knowledge/items?tab=recent'));
    expect(loaded, [Uri.parse('http://127.0.0.1:3999/knowledge/items?tab=recent')]);
  });

  test('without a view, the next one starts at the page asked for, once', () async {
    final settings = page('fuli://settings?tab=system');
    await navigation.open(settings);
    expect(navigation.startPage(console), settings);
    navigation.attach(console, load, startedAt: settings);
    expect(loaded, isEmpty, reason: 'it started there');
    navigation.detach(load);
    expect(navigation.startPage(console), console);
  });

  test('a page asked for while the view was being built loads once it shows', () async {
    final start = navigation.startPage(console);
    await navigation.open(page('fuli://inbox'));
    navigation.attach(console, load, startedAt: start);
    expect(loaded, [Uri.parse('http://127.0.0.1:3999/inbox')]);
  });

  test('a view never loads another console\'s page; the view of that console starts at it', () async {
    navigation.attach(console, load, startedAt: console);
    final elsewhere = FuliLink.parse('fuli://inbox')!.consolePage(4000);
    await navigation.open(elsewhere);
    expect(loaded, isEmpty);
    expect(navigation.startPage(console), console);
    expect(navigation.startPage(Uri.parse('http://127.0.0.1:4000/')), elsewhere);
  });

  test('a view that left the window takes no more pages', () async {
    navigation.attach(console, load, startedAt: console);
    navigation.detach(load);
    await navigation.open(page('fuli://inbox'));
    expect(loaded, isEmpty);
    navigation.detach((_) async {});
    expect(navigation.startPage(console), Uri.parse('http://127.0.0.1:3999/inbox'));
  });

  // The shapes web/src/features/open-in-app/open-in-app.ts builds (its spec has the same links).
  test('the links the console in a browser hands over are console pages', () {
    expect(page('fuli://knowledge/%E9%A1%B9%E7%9B%AE?q=a%20b&tag=x&tag=y&flag'),
        Uri.parse('http://127.0.0.1:3999/knowledge/%E9%A1%B9%E7%9B%AE?q=a%20b&tag=x&tag=y&flag'));
    expect(page('fuli://agents/space/agent-1'), Uri.parse('http://127.0.0.1:3999/agents/space/agent-1'));
    expect(FuliLink.parse('fuli://')!.opensClient, isTrue);
  });
}
