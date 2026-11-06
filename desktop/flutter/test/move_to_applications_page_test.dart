import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/ui/growth_loading.dart';
import 'package:fuli_desktop/src/ui/move_to_applications_page.dart';

import 'support/brand.dart';

const zh = Strings(chinese: true);
const en = Strings(chinese: false);

void main() {
  late Completer<bool> moving;
  late int moves;
  late int declines;

  Future<void> show(WidgetTester tester, Strings strings) {
    // Made inside the test's zone, so completing it runs under the test's clock.
    moving = Completer<bool>();
    moves = 0;
    declines = 0;
    return tester.pumpWidget(MoveToApplicationsApp(
        strings: strings,
        brand: testBrand,
        onMove: () {
          moves++;
          return moving.future;
        },
        onNotNow: () => declines++,
      ));
  }

  testWidgets('offers one move button and a quiet way to go on from here', (tester) async {
    await show(tester, zh);
    expect(find.text('移到「应用程序」'), findsOneWidget);
    expect(find.byIcon(Icons.drive_file_move_rounded), findsOneWidget);
    expect(find.text('这次不移'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);
    // Same row, same height.
    expect(tester.getSize(find.byKey(const Key('not-now'))).height,
        tester.getSize(find.byKey(const Key('move-to-applications'))).height);

    await tester.tap(find.text('这次不移'));
    expect(declines, 1);
    expect(moves, 0);
  });

  testWidgets('moving shows the loading in the button\'s place, and a failure says so in one line', (tester) async {
    await show(tester, en);
    final slot = tester.getRect(find.byKey(const Key('move-to-applications')));
    final notNow = tester.getRect(find.byKey(const Key('not-now')));

    await tester.tap(find.text('Move to Applications'));
    await tester.pump();
    expect(moves, 1);
    expect(find.byType(GrowthLoading), findsOneWidget);
    expect(find.text('Moving to Applications…'), findsOneWidget);
    expect(tester.widget<TextButton>(find.byKey(const Key('not-now'))).onPressed, isNull);
    expect(tester.getRect(find.byKey(const Key('not-now'))), notNow, reason: 'nothing moves while it works');

    moving.complete(false);
    await tester.pump();
    expect(find.byType(GrowthLoading), findsNothing);
    expect(find.text('Could not move to Applications; open FULI from here this time.'), findsOneWidget);
    expect(tester.getRect(find.byKey(const Key('move-to-applications'))), slot);
    expect(tester.getRect(find.byKey(const Key('not-now'))), notNow);

    await tester.tap(find.text('Not now'));
    expect(declines, 1);
  });
}
