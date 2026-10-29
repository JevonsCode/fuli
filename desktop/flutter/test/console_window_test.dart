import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/console_link.dart';
import 'package:fuli_desktop/src/platform/desktop/desktop_window.dart';

void main() {
  final console = Uri.parse('http://127.0.0.1:2828/');

  test('only pages of the console itself stay in the window', () {
    expect(isConsolePage(Uri.parse('http://127.0.0.1:2828/settings?tab=clients'), console), isTrue);
    expect(isConsolePage(Uri.parse('http://127.0.0.1:2829/'), console), isFalse);
    expect(isConsolePage(Uri.parse('http://localhost:2828/'), console), isFalse);
    expect(isConsolePage(Uri.parse('https://127.0.0.1:2828/'), console), isFalse);
    expect(isConsolePage(Uri.parse('https://github.com/JevonsCode/fuli'), console), isFalse);
  });

  test('the window opens at 1280×860 and fits a laptop screen', () {
    expect(openingSize(const Size(2560, 1400)), const Size(1280, 860));
    expect(openingSize(const Size(1366, 728)), Size(1229.4, 728 * 0.9));
  });
}
