import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/fuli_link.dart';

// fuli:// links: what they open, and what they may never reach.
void main() {
  String? page(String text, {int port = 3131}) => FuliLink.parse(text)?.consolePage(port).toString();

  test('status, or nothing after fuli://, opens the client window', () {
    for (final text in ['fuli://status', 'fuli://', 'fuli://status/', 'FULI://status?from=receipt', 'fuli:///status']) {
      expect(FuliLink.parse(text)?.opensClient, isTrue, reason: text);
    }
  });

  test('any other plain path opens that console page on the current port', () {
    expect(page('fuli://knowledge/abc'), 'http://127.0.0.1:3131/knowledge/abc');
    expect(page('fuli://knowledge/abc', port: 2930), 'http://127.0.0.1:2930/knowledge/abc');
    expect(page('fuli://projects/p-1/tasks?item=personal/knowledge:k1&tab=a%20b'),
        'http://127.0.0.1:3131/projects/p-1/tasks?item=personal/knowledge:k1&tab=a%20b');
    expect(page('fuli:///knowledge/abc'), 'http://127.0.0.1:3131/knowledge/abc');
    expect(page('fuli://knowledge/'), 'http://127.0.0.1:3131/knowledge');
    expect(page('fuli://knowledge/%E7%9F%A5%E8%AF%86'), 'http://127.0.0.1:3131/knowledge/%E7%9F%A5%E8%AF%86');
    expect(FuliLink.parse('fuli://knowledge/abc')?.opensClient, isFalse);
    expect(FuliLink.parse('fuli://status/more')?.opensClient, isFalse);
  });

  test('links that try to leave the console or are not plain paths are refused', () {
    for (final text in [
      'fuli://knowledge/../../etc', 'fuli://knowledge/%2e%2e/x', 'fuli://knowledge/%2E%2E', 'fuli://knowledge/./x',
      'fuli://..', 'fuli://knowledge/a%2Fb', 'fuli://knowledge/a%5Cb', 'fuli://knowledge\\x', 'fuli://knowledge//x',
      'fuli://evil.example/x', 'fuli://127.0.0.1:2727/x', 'fuli://user@knowledge/x', 'fuli://knowledge:80/x',
      'fuli://[::1]/x', 'fuli://knowledge/x#top', 'fuli://knowledge/a b', 'fuli://knowledge/知识', 'fuli://knowledge/%00',
      'fuli://knowledge/%ff', 'fuli://knowledge/%zz', 'fuli://knowledge?a=<b>', 'fuli:knowledge', 'http://127.0.0.1:2727/',
      'javascript:alert(1)', 'fuli://knowledge/x"', '--background', '', 'fuli://knowledge/${'a' * maxFuliLinkLength}',
    ]) {
      expect(FuliLink.parse(text), isNull, reason: text);
    }
  });

  test('a link keeps the text it was given', () {
    expect(FuliLink.parse('fuli://knowledge/abc?x=1')?.text, 'fuli://knowledge/abc?x=1');
  });
}
