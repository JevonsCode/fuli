import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/ui/growth_loading.dart';
import 'package:fuli_desktop/src/ui/old_version_page.dart';

import 'support/brand.dart';

const zh = Strings(chinese: true);
const en = Strings(chinese: false);

void main() {
  late Completer<bool> opening;
  late int opens;

  Future<void> show(WidgetTester tester, Strings strings) {
    opening = Completer<bool>();
    opens = 0;
    return tester.pumpWidget(OldVersionApp(
      strings: strings,
      brand: testBrand,
      onOpenNew: () {
        opens++;
        return opening.future;
      },
    ));
  }

  testWidgets('says in plain words that this window is the old version, with one button', (tester) async {
    await show(tester, zh);
    expect(find.text('这是旧版本的 FULI。'), findsOneWidget);
    expect(find.text('打开新版本'), findsOneWidget);
    expect(find.byType(FilledButton), findsOneWidget);
    expect(find.byType(TextButton), findsNothing);
    expect(find.textContaining('installation record'), findsNothing);

    await show(tester, en);
    expect(find.text('This window is an older version of FULI.'), findsOneWidget);
    expect(find.text('Open the new version'), findsOneWidget);
  });

  testWidgets('opening shows the loading in the button\'s place; a failure says so in one line', (tester) async {
    await show(tester, en);
    final slot = tester.getRect(find.byKey(const Key('open-new-version')));
    final line = tester.getRect(find.byKey(const Key('old-version')));

    await tester.tap(find.text('Open the new version'));
    await tester.pump();
    expect(opens, 1);
    expect(find.byType(GrowthLoading), findsOneWidget);
    expect(find.text('Opening the new version…'), findsOneWidget);

    opening.complete(false);
    await tester.pump();
    expect(find.byKey(const Key('open-new-version-failed')), findsOneWidget);
    expect(find.text('Could not open the new version; close this and open FULI again.'), findsOneWidget);
    // Nothing moved when the loading and the notice came and went.
    expect(tester.getRect(find.byKey(const Key('open-new-version'))), slot);
    expect(tester.getRect(find.byKey(const Key('old-version'))), line);
  });
}
