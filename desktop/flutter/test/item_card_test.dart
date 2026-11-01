import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/doctor/doctor_report.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/ui/item_card.dart';
import 'package:fuli_desktop/src/ui/theme.dart';

const zh = Strings(chinese: true);

void main() {
  late List<String> calls;

  setUp(() => calls = []);

  Future<void> show(WidgetTester tester, DoctorItem item, {bool enabled = true}) => tester.pumpWidget(MaterialApp(
        theme: fuliTheme(),
        home: Scaffold(
          body: ItemCard(
            item: item,
            strings: zh,
            enabled: enabled,
            onRepair: () => calls.add('repair'),
            onReview: () => calls.add('review'),
            onUpdate: (version) => calls.add('update $version'),
          ),
        ),
      ));

  final buttons = find.byWidgetPredicate((widget) => widget is ButtonStyleButton);

  testWidgets('every card has one sentence and at most one button, and the button does its one thing', (tester) async {
    final expected = {
      'client-codex': ('自动修复', 'repair'),
      'format-tasks': ('查看并确认', 'review'),
      'sessions-claude': null,
      'update': ('更新到 v0.23.0', 'update 0.23.0'),
    };
    for (final item in demoItems) {
      calls.clear();
      await show(tester, item);
      expect(find.text(zh.explain(item)), findsOneWidget, reason: item.id);
      final action = expected[item.id];
      if (action == null) {
        expect(buttons, findsNothing, reason: item.id);
        continue;
      }
      expect(buttons, findsOneWidget, reason: item.id);
      await tester.tap(find.text(action.$1));
      expect(calls, [action.$2], reason: item.id);
    }
  });

  testWidgets('while an operation runs, the card button waits', (tester) async {
    await show(tester, demoItems.first, enabled: false);
    await tester.tap(find.text('自动修复'));
    expect(calls, isEmpty);
  });

  testWidgets('a detail stays folded until the card is clicked, and the open card lifts', (tester) async {
    const item = DoctorItem(id: 'new', kind: 'something_new', severity: DoctorSeverity.warning, fix: DoctorFix.person);
    await show(tester, item);
    expect(find.text('something_new'), findsNothing);
    BoxDecoration decoration() => tester.widget<AnimatedContainer>(find.byType(AnimatedContainer)).decoration! as BoxDecoration;
    expect(decoration().boxShadow, FuliShadow.xs);

    await tester.tap(find.text(zh.explain(item)));
    await tester.pumpAndSettle();
    expect(find.text('something_new'), findsOneWidget);
    expect(decoration().boxShadow, FuliShadow.md);
    expect(decoration().border, isNot(isA<BorderDirectional>()), reason: 'lifted, never a side bar');

    await tester.tap(find.text(zh.explain(item)));
    await tester.pumpAndSettle();
    expect(find.text('something_new'), findsNothing);
  });
}
